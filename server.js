const express = require("express");
const fs = require("fs");
const fsp = require("fs").promises;
const path = "path" in globalThis ? globalThis.path : require("path");
const axios = "axios" in globalThis ? globalThis.axios : require("axios");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

// --- ניהול מסד נתונים מבוסס קובץ JSON (משופר ואסינכרוני) ---
const DB_FILE = path.join(__dirname, "database.json");

let dbData = { bannedPhones: [] };
let dbWritePromise = Promise.resolve();

try {
  if (fs.existsSync(DB_FILE)) {
    const fileContent = fs.readFileSync(DB_FILE, "utf-8");
    dbData = JSON.parse(fileContent);
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
  }
} catch (err) {
  console.error("❌ שגיאה בטעינת מסד הנתונים המקומי בסטארטאפ:", err.message);
}

// שומר על תור כתיבות למניעת השחתת הקובץ בסביבה מקבילית
const saveDb = () => {
  dbWritePromise = dbWritePromise
    .then(() => fsp.writeFile(DB_FILE, JSON.stringify(dbData, null, 2)))
    .catch((err) => console.error("❌ שגיאה בשמירת מסד הנתונים:", err.message));
  return dbWritePromise;
};

const bannedPhones = new Set(dbData.bannedPhones || []);
console.log(`🔒 נטענו ${bannedPhones.size} מספרים חסומים ממסד הנתונים המקומי.`);

// סנכרון ממשתני סביבה בעליית השרת
if (process.env.INITIAL_BANNED_PHONES) {
  try {
    const parsedBanned = JSON.parse(process.env.INITIAL_BANNED_PHONES);
    if (Array.isArray(parsedBanned)) {
      parsedBanned.forEach((phone) => {
        bannedPhones.add(String(phone).trim());
      });
      dbData.bannedPhones = Array.from(bannedPhones);
      saveDb(); // Fire and forget in startup
      console.log(`🔒 סונכרנו ${bannedPhones.size} מספרים חסומים ממשתני הסביבה.`);
    }
  } catch (err) {
    console.error("❌ שגיאה בפענוח INITIAL_BANNED_PHONES:", err.message);
  }
}

const processedCalls = new Map();
const conversationHistory = new Map();

const blockUserPermanently = async (phone) => {
  bannedPhones.add(phone);
  dbData.bannedPhones = Array.from(bannedPhones);
  await saveDb();

  if (conversationHistory.has(phone)) {
    const session = conversationHistory.get(phone);
    if (session.timer) clearTimeout(session.timer);
    conversationHistory.delete(phone);
  }
};

const unblockUser = async (phone) => {
  const existed = bannedPhones.delete(phone);
  if (existed) {
    dbData.bannedPhones = Array.from(bannedPhones);
    await saveDb();
  }
  return existed;
};

let geminiCooldownUntil = 0;

// ניקוי זיכרון תקופתי
setInterval(() => {
  const now = Date.now();
  console.log("🧹 מפעיל ניקוי זיכרון תקופתי להסטוריית השיחות...");
  for (const [phone, session] of conversationHistory.entries()) {
    if (session.lastActive && now - session.lastActive > 10 * 60 * 1000) {
      if (session.timer) clearTimeout(session.timer);
      conversationHistory.delete(phone);
    }
  }
  // הגנת הצפת זיכרון
  if (conversationHistory.size > 500) {
    const oldestKeys = Array.from(conversationHistory.keys()).slice(0, conversationHistory.size - 500);
    oldestKeys.forEach((key) => {
      const s = conversationHistory.get(key);
      if (s?.timer) clearTimeout(s.timer);
      conversationHistory.delete(key);
    });
  }
}, 60 * 60 * 1000);

const normalizeText = (text) => {
  if (!text) return "";
  return text
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[,.?!:;'"״׳`_\-*~#–—&?=<>/()\\[\]{}]/g, " ")
    .replace(/ם/g, "מ")
    .replace(/ן/g, "נ")
    .replace(/ץ/g, "צ")
    .replace(/ף/g, "פ")
    .replace(/ך/g, "כ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
};

const RESET_TRIGGERS = [
  "תתחיל מחדש", "תתחילי מחדש", "אפס שיחה", "איפוס שיחה",
  "שיחה חדשה", "התחל מחדש", "תמחק היסטוריה", "ניקוי היסטוריה"
].map(normalizeText);

const DEEP_DETAILS_TRIGGERS = [
  "תתעמק", "תתעמקי", "תרחיב", "תרחיבי", "בהרחבה",
  "תפרט", "תפרטי", "עוד מידע", "פירוט", "מידע מפורט"
].map(normalizeText);

const BLOCKED_KEYWORDS = [
  "סקס", "פורנו", "עירום", "זונה", "שרמוטה", "אונס",
  "זין", "כוס", "מזדיין", "להזדיין", "זיון", "מציצה",
  "סרט כחול", "אנאלי", "אוראלי", "גורן", "סטריפטיז", "איכסה"
].map(normalizeText);

const getWarningMessage = (attempts) => {
  if (attempts === 1) return "המפתחים שלי הגדירו שאסור לי לענות על זה זוהי אזהרה ראשונה מתוך שלוש במידה ותגיע לשלוש אזהרות תחסם מהמערכת";
  if (attempts === 2) return "המפתחים שלי הגדירו שאסור לי לענות על זה זוהי אזהרה שנייה מתוך שלוש באזהרה הבאה תחסם מהמערכת";
  return "חשבונך נחסם לשימוש במערכת עקב חריגה מוגזמת מכללי השימוש";
};

const BANNED_USER_RESPONSE = "חשבונך נחסם לשימוש במערכת עקב חריגה מוגזמת מכללי השימוש";
const BLOCKED_RESPONSE_MARKER = normalizeText("המפתחים שלי הגדירו לי שאסור לי לענות על זה");

const authenticateAdmin = (req, res, next) => {
  const adminKey = process.env.ADMIN_KEY;
  const providedKey = req.query.key || req.body?.key;

  if (!adminKey) {
    return res.status(500).json({ error: "ADMIN_KEY isn't defined in server environment variables" });
  }
  if (!providedKey || providedKey !== adminKey) {
    return res.status(401).json({ error: "Unauthorized: Invalid or missing admin key" });
  }
  next();
};

app.get("/admin/banned", authenticateAdmin, (req, res) => {
  res.status(200).json({
    totalBanned: bannedPhones.size,
    bannedPhones: Array.from(bannedPhones)
  });
});

app.get("/admin/add-ban", authenticateAdmin, async (req, res) => {
  const phone = (req.query.phone || "").trim();
  if (!phone) return res.status(400).json({ error: "Missing 'phone' parameter" });

  await blockUserPermanently(phone);
  res.status(200).json({
    message: `Phone number ${phone} added to banned list successfully`,
    totalBanned: bannedPhones.size
  });
});

app.get("/admin/remove-ban", authenticateAdmin, async (req, res) => {
  const phone = (req.query.phone || "").trim();
  if (!phone) return res.status(400).json({ error: "Missing 'phone' parameter" });

  const existed = await unblockUser(phone);
  res.status(200).json({
    message: existed
      ? `Phone number ${phone} removed from banned list successfully`
      : `Phone number ${phone} was not in the banned list`,
    totalBanned: bannedPhones.size
  });
});

app.get("/ping", (req, res) => res.status(200).send("PONG"));

app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "ok", 
    geminiOnCooldown: Date.now() < geminiCooldownUntil,
    activeSessions: conversationHistory.size,
    bannedUsersCount: bannedPhones.size,
    timestamp: new Date() 
  });
});

const callGeminiSimple = async (model, payload, geminiApiKey) => {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
  return axios.post(geminiUrl, payload, { 
    headers: { "Content-Type": "application/json" }, 
    timeout: 12000 
  });
};

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };

    // --- לוגים מפורטים לבדיקת הנתונים המגיעים מימות ---
    console.log("\n==================================================");
    console.log("📥 [Yemot Incoming Request Debug]");
    console.log("Method:", req.method);
    console.log("Query Params:", JSON.stringify(req.query, null, 2));
    console.log("Body Params:", JSON.stringify(req.body, null, 2));
    console.log("==================================================\n");

    const callId = params.ApiCallId || params.ApiYFCallId;
    const userPhone = params.ApiPhone || params.phone || "default_user";
    const systemDid = params.ApiRealDID || params.ApiDID || "לא ידוע";
    const secondaryFolder = params.SHL || "1";
    const primaryFolder = params.SHM || "2";
    const requestedModel = params.MODEL || params.model;
    const token = params.token || params.TOKEN || params.ApiToken || params.SessionToken || params.Session_Token || process.env.YM_API_TOKEN;

    console.log("\n==================================================");
    console.log("📞 [ימות המשיח] התקבלה פנייה חדשה למערכת!");
    console.log(`🏢 מספר מערכת (DID): ${systemDid}`);
    console.log(`📌 מספר טלפון מתקשר: ${userPhone}`);
    console.log("==================================================\n");

    if (callId && processedCalls.has(callId)) {
      console.log(`⚠️ שיחה כפולה זוהתה (CallID: ${callId}), מתעלם ומחזיר לתיקייה.`);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`go_to_folder=/1`);
    }

    if (callId) {
      processedCalls.set(callId, Date.now());
      setTimeout(() => processedCalls.delete(callId), 10000);
    }

    if (bannedPhones.has(userPhone)) {
      console.log(`🚫 המספר ${userPhone} נמצא ברשימת החסומים! חוסם שיחה.`);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-${BANNED_USER_RESPONSE}&go_to_folder=/1`);
    }

    let userSession = conversationHistory.get(userPhone) || { 
      history: [], 
      timer: null, 
      lastActive: Date.now(),
      blockedAttempts: 0 
    };

    const parsedGeminiKeys = new Set([process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_1].filter(Boolean));
    const parsedOpenRouterKeys = new Set([process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY_1].filter(Boolean));
    let parsedDeepgram = process.env.DEEPGRAM_API_KEY || "";

    // בדיקה מפורשת למפתחות המגיעים ישירות כפרמטרים מימות
    const explicitGemini = params.GEMINI_API_KEY || params.gemini_key || params.GeminiKey || params.AI_KEY;
    if (explicitGemini) parsedGeminiKeys.add(String(explicitGemini).trim());

    const explicitOpenRouter = params.OPENROUTER_API_KEY || params.openrouter_key || params.OpenRouterKey;
    if (explicitOpenRouter) parsedOpenRouterKeys.add(String(explicitOpenRouter).trim());

    const explicitDeepgram = params.DEEPGRAM_API_KEY || params.deepgram_key || params.DeepgramKey;
    if (explicitDeepgram) parsedDeepgram = String(explicitDeepgram).trim();

    // סריקה עמוקה למציאת מפתחות בתוך מבנים מקוננים
    const extractKeysDeeply = (obj, depth = 0) => {
      if (depth > 5 || !obj) return; 
      for (const value of Object.values(obj)) {
        const items = Array.isArray(value) ? value : [value];
        for (const item of items) {
          if (typeof item === "string") {
            const parts = item.split(/[\s,;|]+/).map(p => p.trim()).filter(Boolean);
            for (const part of parts) {
              if (part.startsWith("AIza") || part.startsWith("QA.A")) {
                parsedGeminiKeys.add(part);
              } else if (part.startsWith("sk-or-")) {
                parsedOpenRouterKeys.add(part);
              } else if (part.length === 40 && /^[a-f0-9]{40}$/i.test(part)) {
                parsedDeepgram = part;
              }
            }
          } else if (typeof item === "object" && item !== null) {
            extractKeysDeeply(item, depth + 1);
          }
        }
      }
    };

    extractKeysDeeply(params);

    const geminiKeys = Array.from(parsedGeminiKeys);
    const openRouterKeys = Array.from(parsedOpenRouterKeys);
    const deepgramApiKey = parsedDeepgram.trim();

    console.log(`🔑 מפתחות שזוהו: Gemini (${geminiKeys.length}), OpenRouter (${openRouterKeys.length}), Deepgram (${deepgramApiKey ? "1" : "0"})`);

    let audioBuffer = null;
    const possiblePaths = [];

    if (params.path) possiblePaths.push(params.path);
    if (params.Path) possiblePaths.push(params.Path);
    if (params.file) possiblePaths.push(params.file);
    if (params.File) possiblePaths.push(params.File);
    if (params.ApiPath) possiblePaths.push(params.ApiPath);
    possiblePaths.push(`ivr2:/${secondaryFolder}/last.wav`);
    possiblePaths.push(`ivr2:/${primaryFolder}/last.wav`);

    console.log("📁 מנסה להוריד את קובץ השמע מהנתיבים האפשריים...");
    for (let rawPath of possiblePaths) {
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      
      if (!token) {
        console.log("❌ שגיאה: לא נמצא טוקן (Token) לאימות מול ימות המשיח.");
        break;
      }

      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;

      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 8000 });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          console.log(`✅ ההקלטה הורדה בהצלחה מנתיב: ${cleanPath} (גודל: ${audioBuffer.length} באייט)`);
          break;
        }
      } catch (err) {
        // מתעלם ועובר לנתיב הבא
      }
    }

    if (!audioBuffer) {
      console.log("❌ שגיאה: לא נמצאה הקלטה תקינה באף אחד מהנתיבים.");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-לא נמצאה הקלטה תקינה אנא הקלט שוב&go_to_folder=/1`);
    }

    let transcribedText = "";

    if (deepgramApiKey) {
      try {
        console.log("🎙️ שולח את השמע לתמלול ב-Deepgram...");
        const dgResponse = await axios.post(
          "https://api.deepgram.com/v1/listen?language=he&model=nova-3",
          audioBuffer,
          {
            headers: {
              "Authorization": `Token ${deepgramApiKey}`,
              "Content-Type": "audio/wav"
            },
            timeout: 10000
          }
        );
        transcribedText = (dgResponse.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim();
        console.log(`📝 [Deepgram Success]: "${transcribedText}"`);
      } catch (err) {
        console.error("❌ שגיאה בתמלול Deepgram (עובר לגיבוי Gemini):", err.response?.data || err.message);
      }
    }

    const normalizedTranscription = normalizeText(transcribedText);

    // בדיקת חסימות (מילים גסות)
    const isBlocked = BLOCKED_KEYWORDS.some(keyword => normalizedTranscription.includes(keyword));
    if (isBlocked) {
      userSession.blockedAttempts += 1;
      console.log(`🛑 זוהה תוכן לא ראוי בתמלול! אזהרה ${userSession.blockedAttempts}/3 למספר ${userPhone}`);

      if (userSession.blockedAttempts >= 3) {
        console.log(`🔒 המספר ${userPhone} הגיע ל-3 אזהרות! חוסם לצמיתות.`);
        await blockUserPermanently(userPhone);
        res.set("Content-Type", "text/plain; charset=utf-8");
        return res.send(`id_list_message=t-${BANNED_USER_RESPONSE}&go_to_folder=/1`);
      }

      userSession.lastActive = Date.now();
      conversationHistory.set(userPhone, userSession);
      const warningMsg = getWarningMessage(userSession.blockedAttempts);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-${warningMsg}&go_to_folder=/1`);
    }

    // איפוס שיחה
    const isResetRequested = RESET_TRIGGERS.some(trigger => normalizedTranscription.includes(trigger));
    if (isResetRequested) {
      console.log("🔄 זוהתה בקשת איפוס שיחה!");
      if (userSession.timer) clearTimeout(userSession.timer);
      
      const currentWarnings = userSession.blockedAttempts;
      conversationHistory.set(userPhone, {
        history: [],
        timer: null,
        lastActive: Date.now(),
        blockedAttempts: currentWarnings
      });

      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-השיחה אופסה בהצלחה במה אוכל לעזור&go_to_folder=/1`);
    }

    const isDeepRequested = DEEP_DETAILS_TRIGGERS.some(trigger => normalizedTranscription.includes(trigger));

    if (userSession.timer) clearTimeout(userSession.timer);
    userSession.lastActive = Date.now();
    userSession.timer = setTimeout(() => {
      conversationHistory.delete(userPhone);
    }, 10 * 60 * 1000);

    let finalAnswerText = "";
    
    const basePersonality = "אתה עוזר קולי יעיל. כאשר שואלים אותך מה חדש חדשות או שאלות עובדתיות ענה באופן עובדתי ואינפורמטיבי. כלל ברזל חשוב: אם המשתמש שואל שאלה בעלת אופי מיני בוטה שוביניסטי או תוכן לא ראוי ענה אך ורק במילים המפתחים שלי הגדירו לי שאסור לי לענות על זה. לעולם אל תשתמש בסימני פיסוק. אל תאמר שאין לך גישה לאינטרנט או שאתה מודל שפה. אם נדרשת מילה באנגלית הפרד את האותיות ברווחים.";
    
    const systemInstruction = isDeepRequested
      ? `${basePersonality} המשתמש ביקש שתתעמק ותפרט. ענה בצורה מפורטת ומורחבת עד 120 מילים סהכ.`
      : `${basePersonality} ענה בציטוט קצר ותמציתי עד 35 מילים בלבד.`;

    const isTranscriptionWeak = !transcribedText || transcribedText.split(" ").length < 2;
    const lowerTranscription = transcribedText.toLowerCase();
    const needsSearch = lowerTranscription.startsWith("חפש") || lowerTranscription.includes(" חפש ") ||
                        lowerTranscription.includes("חדשות") || lowerTranscription.includes("עדכון") || lowerTranscription.includes("היום");

    const isGeminiOnCooldown = Date.now() < geminiCooldownUntil;

    // --- שלב 1: Gemini ---
    if (!isGeminiOnCooldown && geminiKeys.length > 0) {
      const geminiModels = requestedModel 
        ? [requestedModel, "gemini-2.5-flash-lite", "gemini-2.5-flash"] 
        : ["gemini-2.5-flash-lite", "gemini-2.5-flash"];

      const geminiContents = [
        { role: "user", parts: [{ text: systemInstruction }] },
        { role: "model", parts: [{ text: "מבין עונה לפי ההנחיות והערכים הנדרשים." }] }
      ];

      userSession.history.forEach((msg) => {
        geminiContents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }]
        });
      });

      if (isTranscriptionWeak) {
        geminiContents.push({
          role: "user",
          parts: [
            { text: isDeepRequested ? "האזן להקלטה הבאה וענה בהרחבה ומפורט:" : "האזן להקלטה הבאה והשב עליה בקצרה עד 35 מילים:" },
            { inlineData: { mimeType: "audio/wav", data: audioBuffer.toString("base64") } }
          ]
        });
      } else {
        geminiContents.push({ role: "user", parts: [{ text: transcribedText }] });
      }

      const payload = { contents: geminiContents };
      if (needsSearch) payload.tools = [{ googleSearch: {} }];

      for (let k = 0; k < geminiKeys.length; k++) {
        if (finalAnswerText) break;
        const apiKey = geminiKeys[k];
        for (const model of geminiModels) {
          try {
            console.log(`🤖 מנסה Gemini | מפתח ${k + 1} \vert{} מודל ${model}...`);
            const response = await callGeminiSimple(model, payload, apiKey);
            if (response?.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
              finalAnswerText = response.data.candidates[0].content.parts[0].text;
              if (isTranscriptionWeak) transcribedText = "[שמע שפוענח ישירות ע״י Gemini]";
              console.log(`✅ [Gemini Success] התקבלה תשובה.`);
              break;
            }
          } catch (err) {
            const statusCode = err.response?.status;
            console.log(`❌ [Gemini Error] מודל ${model} נכשל: ${statusCode || "ללא קוד"}`);
            if (statusCode === 429) {
              geminiCooldownUntil = Date.now() + 10 * 60 * 1000;
              console.log("⛔ חריגת מכסה 429 ב-Gemini! מפעיל הפוגה של 10 דקות.");
            }
          }
        }
      }
    }

    // --- שלב 2: OpenRouter ---
    if (!finalAnswerText && openRouterKeys.length > 0 && transcribedText && !transcribedText.startsWith("[שמע")) {
      const messagesPayload = [
        { role: "system", content: systemInstruction },
        ...userSession.history,
        { role: "user", content: transcribedText }
      ];

      for (let i = 0; i < openRouterKeys.length; i++) {
        if (finalAnswerText) break;
        try {
          console.log(`🌐 מנסה OpenRouter | מפתח ${i + 1}...`);
          const openRouterCompletion = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            { model: "openrouter/free", messages: messagesPayload, temperature: 0.3 },
            { 
              headers: { 
                "Authorization": `Bearer ${openRouterKeys[i].trim()}`, 
                "Content-Type": "application/json",
                "HTTP-Referer": "https://yemot-telephony-ai.com"
              }, 
              timeout: 12000 
            }
          );
          finalAnswerText = openRouterCompletion.data?.choices?.[0]?.message?.content || "";
          if (finalAnswerText) {
            console.log(`✅ [OpenRouter Success] התקבלה תשובה.`);
            break;
          }
        } catch (err) {
          console.log(`❌ [OpenRouter Error] מפתח ${i + 1} נכשל.`);
        }
      }
    }

    if (!finalAnswerText) {
      console.log("❌ כל המודלים (Gemini ו-OpenRouter) נכשלו או הגיעו למכסה!");
      finalAnswerText = "הגעת למכסה היומית אנא נסה שוב מאוחר יותר";
    }

    const normalizedAnswer = normalizeText(finalAnswerText);
    if (normalizedAnswer.includes(BLOCKED_RESPONSE_MARKER)) {
      userSession.blockedAttempts += 1;
      if (userSession.blockedAttempts >= 3) {
        await blockUserPermanently(userPhone);
        res.set("Content-Type", "text/plain; charset=utf-8");
        return res.send(`id_list_message=t-${BANNED_USER_RESPONSE}&go_to_folder=/1`);
      }
      conversationHistory.set(userPhone, userSession);
      const warningMsg = getWarningMessage(userSession.blockedAttempts);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-${warningMsg}&go_to_folder=/1`);
    }

    const cleanText = finalAnswerText
      .replace(/[,.?!:;'"״׳`_\-*~#–—&?=<>/()\\[\]{}]/g, " ") 
      .replace(/\s+/g, " ")                                     
      .trim();

    console.log(`💬 [Final Answer Ready]: "${cleanText}"`);

    // שמירת היסטוריית השיחה (רק אם היה טקסט חוקי ולא "[שמע...")
    if (transcribedText && !transcribedText.startsWith("[שמע")) {
      userSession.history.push({ role: "user", content: transcribedText });
      userSession.history.push({ role: "assistant", content: cleanText });
      if (userSession.history.length > 6) userSession.history = userSession.history.slice(-6);
      conversationHistory.set(userPhone, userSession);
    }

    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-${cleanText}&go_to_folder=/1`);

  } catch (error) {
    console.error("❌ === שגיאה כללית בקוד ===", error.message);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-חלה שגיאה במערכת אנא נסה שנית&go_to_folder=/1`);
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
