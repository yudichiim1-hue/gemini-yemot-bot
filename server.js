const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();

// הגבלת משקל בקשה ל-10MB למניעת התקפות DoS (מספיק די והותר להקלטות שמע IVR)
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));

// --- ניהול מסד נתונים מבוסס קובץ JSON פשוט ואמין ---
const DB_FILE = path.join(__dirname, "database.json");
const DB_TMP_FILE = path.join(__dirname, "database.tmp.json");

let dbData = { bannedPhones: [] };
const bannedPhones = new Set();

// טעינה ראשונית - סינכרוני רק בעליית השרת
try {
  if (fs.existsSync(DB_FILE)) {
    const fileContent = fs.readFileSync(DB_FILE, "utf-8");
    dbData = JSON.parse(fileContent);
    (dbData.bannedPhones || []).forEach(phone => bannedPhones.add(phone));
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
  }
} catch (err) {
  console.error("❌ שגיאה בטעינת מסד הנתונים המקומי:", err.message);
}

// שמירה אסינכרונית בטוחה (Atomic Write) כדי למנוע השחתת קובץ ולא לחסום את ה-Event Loop
const saveDb = async () => {
  try {
    const dataString = JSON.stringify(dbData, null, 2);
    await fs.promises.writeFile(DB_TMP_FILE, dataString);
    await fs.promises.rename(DB_TMP_FILE, DB_FILE);
  } catch (err) {
    console.error("❌ שגיאה בשמירת מסד הנתונים:", err.message);
  }
};

console.log(`🔒 נטענו ${bannedPhones.size} מספרים חסומים ממסד הנתונים המקומי.`);

// טעינת מספרים חסומים ממשתני סביבה
if (process.env.INITIAL_BANNED_PHONES) {
  try {
    const parsedBanned = JSON.parse(process.env.INITIAL_BANNED_PHONES);
    if (Array.isArray(parsedBanned)) {
      parsedBanned.forEach((phone) => bannedPhones.add(String(phone).trim()));
      dbData.bannedPhones = Array.from(bannedPhones);
      saveDb(); // אסינכרוני, השרת ממשיך לעלות
      console.log(`🔒 סונכרנו ${bannedPhones.size} מספרים חסומים ממשתני הסביבה.`);
    }
  } catch (err) {
    console.error("❌ שגיאה בפענוח INITIAL_BANNED_PHONES:", err.message);
  }
}

const processedCalls = new Map();
const conversationHistory = new Map();
const geminiKeyCooldowns = new Map(); // שומר Cooldown לכל מפתח בנפרד במקום משתנה גלובלי

const blockUserPermanently = async (phone) => {
  bannedPhones.add(phone);
  dbData.bannedPhones = Array.from(bannedPhones);
  await saveDb();

  if (conversationHistory.has(phone)) {
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

// 🧹 מנקה אשפה תקופתי - רץ פעם בשעה
setInterval(() => {
  const now = Date.now();
  console.log("🧹 מפעיל ניקוי זיכרון תקופתי להסטוריית השיחות וקריאות כפולות...");
  
  // ניקוי היסטוריית שיחות ישנה (מעל 10 דקות)
  for (const [phone, session] of conversationHistory.entries()) {
    if (session.lastActive && now - session.lastActive > 10 * 60 * 1000) {
      conversationHistory.delete(phone);
    }
  }
  
  // הגבלת כמות השיחות השמורות בזיכרון למניעת דליפות RAM
  if (conversationHistory.size > 500) {
    const keysToDelete = Array.from(conversationHistory.keys()).slice(0, conversationHistory.size - 500);
    keysToDelete.forEach(key => conversationHistory.delete(key));
  }

  // ניקוי מזהי שיחות כפולות ישנים
  for (const [callId, timestamp] of processedCalls.entries()) {
    if (now - timestamp > 15000) {
      processedCalls.delete(callId);
    }
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

const RESET_TRIGGERS = ["תתחיל מחדש", "תתחילי מחדש", "אפס שיחה", "איפוס שיחה", "שיחה חדשה", "התחל מחדש", "תמחק היסטוריה", "ניקוי היסטוריה"].map(normalizeText);
const DEEP_DETAILS_TRIGGERS = ["תתעמק", "תתעמקי", "תרחיב", "תרחיבי", "בהרחבה", "תפרט", "תפרטי", "עוד מידע", "פירוט", "מידע מפורט"].map(normalizeText);
const BLOCKED_KEYWORDS = ["סקס", "פורנו", "עירום", "זונה", "שרמוטה", "אונס", "זין", "כוס", "מזדיין", "להזדיין", "זיון", "מציצה", "סרט כחול", "אנאלי", "אוראלי", "גורן", "סטריפטיז", "איכסה"].map(normalizeText);

const BANNED_USER_RESPONSE = "חשבונך נחסם לשימוש במערכת עקב חריגה מוגזמת מכללי השימוש";
const BLOCKED_RESPONSE_MARKER = normalizeText("המפתחים שלי הגדירו לי שאסור לי לענות על זה");

const getWarningMessage = (attempts) => {
  if (attempts === 1) return "המפתחים שלי הגדירו שאסור לי לענות על זה זוהי אזהרה ראשונה מתוך שלוש במידה ותגיע לשלוש אזהרות תחסם מהמערכת";
  if (attempts === 2) return "המפתחים שלי הגדירו שאסור לי לענות על זה זוהי אזהרה שנייה מתוך שלוש באזהרה הבאה תחסם מהמערכת";
  return BANNED_USER_RESPONSE;
};

// Middleware לאימות מנהל (תומך גם ב-Headers שזה מאובטח יותר)
const authenticateAdmin = (req, res, next) => {
  const adminKey = process.env.ADMIN_KEY;
  const providedKey = req.headers['x-admin-key'] || req.headers.authorization?.replace('Bearer ', '') || req.query.key || req.body?.key;

  if (!adminKey) {
    return res.status(500).json({ error: "ADMIN_KEY isn't defined in server environment variables" });
  }
  if (!providedKey || providedKey !== adminKey) {
    return res.status(401).json({ error: "Unauthorized: Invalid or missing admin key" });
  }
  next();
};

app.get("/admin/banned", authenticateAdmin, (req, res) => {
  res.status(200).json({ totalBanned: bannedPhones.size, bannedPhones: Array.from(bannedPhones) });
});

app.get("/admin/add-ban", authenticateAdmin, async (req, res) => {
  const phone = (req.query.phone || "").trim();
  if (!phone) return res.status(400).json({ error: "Missing 'phone' parameter" });

  await blockUserPermanently(phone);
  res.status(200).json({ message: `Phone number ${phone} added to banned list successfully`, totalBanned: bannedPhones.size });
});

app.get("/admin/remove-ban", authenticateAdmin, async (req, res) => {
  const phone = (req.query.phone || "").trim();
  if (!phone) return res.status(400).json({ error: "Missing 'phone' parameter" });

  const existed = await unblockUser(phone);
  res.status(200).json({
    message: existed ? `Phone number ${phone} removed from banned list successfully` : `Phone number ${phone} was not in the banned list`,
    totalBanned: bannedPhones.size
  });
});

app.get("/ping", (req, res) => res.status(200).send("PONG"));

app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "ok", 
    activeSessions: conversationHistory.size,
    bannedUsersCount: bannedPhones.size,
    timestamp: new Date() 
  });
});

const callGeminiSimple = async (model, payload, geminiApiKey) => {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
  return await axios.post(geminiUrl, payload, { 
    headers: { "Content-Type": "application/json" }, 
    timeout: 12000 
  });
};

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const callId = params.ApiCallId || params.ApiYFCallId;
    const userPhone = params.ApiPhone || params.phone || "default_user";
    const systemDid = params.ApiRealDID || params.ApiDID || "לא ידוע";
    const secondaryFolder = params.SHL || "1";
    const primaryFolder = params.SHM || "2";
    const requestedModel = params.MODEL || params.model;
    const token = params.token || params.TOKEN || params.ApiToken || params.SessionToken || params.Session_Token || process.env.YM_API_TOKEN;

    console.log("\n==================================================");
    console.log("📞 [ימות המשיח] התקבלה פנייה חדשה למערכת!");
    console.log(`🏢 מספר מערכת (DID): ${systemDid} \vert{} מתקשר: ${userPhone}`);
    console.log("==================================================\n");

    // מניעת שיחות כפולות - יעיל יותר, ללא יצירת אלפי setTimeouts
    if (callId) {
      const lastCallTime = processedCalls.get(callId);
      if (lastCallTime && Date.now() - lastCallTime < 10000) {
        console.log(`⚠️ שיחה כפולה זוהתה (CallID: ${callId}), מתעלם ומחזיר לתיקייה.`);
        return res.status(200).type("text/plain").send(`go_to_folder=/1`);
      }
      processedCalls.set(callId, Date.now());
    }

    if (bannedPhones.has(userPhone)) {
      console.log(`🚫 המספר ${userPhone} נמצא ברשימת החסומים! חוסם שיחה.`);
      return res.status(200).type("text/plain").send(`id_list_message=t-${BANNED_USER_RESPONSE}&go_to_folder=/1`);
    }

    let userSession = conversationHistory.get(userPhone) || { 
      history: [], 
      lastActive: Date.now(),
      blockedAttempts: 0 
    };
    userSession.lastActive = Date.now(); // רענון פעילות

    // --- חילוץ חכם עם הגנת Depth & Circular Reference ---
    const parsedGeminiKeys = new Set([process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_1].filter(Boolean));
    const parsedOpenRouterKeys = new Set([process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY_1].filter(Boolean));
    let parsedDeepgram = process.env.DEEPGRAM_API_KEY || "";

    const extractKeysDeeply = (obj, visited = new WeakSet(), depth = 0) => {
      if (depth > 5 || !obj || typeof obj !== "object") return; // הגבלת עומק למניעת קריסה
      if (visited.has(obj)) return; // מניעת לולאה אין-סופית
      visited.add(obj);

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
            extractKeysDeeply(item, visited, depth + 1);
          }
        }
      }
    };
    extractKeysDeeply(params);

    const geminiKeys = Array.from(parsedGeminiKeys);
    const openRouterKeys = Array.from(parsedOpenRouterKeys);
    const deepgramApiKey = parsedDeepgram.trim();

    let audioBuffer = null;
    const possiblePaths = [params.path, params.Path, params.file, params.File, params.ApiPath, `ivr2:/${secondaryFolder}/last.wav`, `ivr2:/${primaryFolder}/last.wav`].filter(Boolean);

    for (let rawPath of possiblePaths) {
      if (!token) break;
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;

      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 8000 });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          console.log(`✅ ההקלטה הורידה מנתיב: ${cleanPath} (גודל: ${audioBuffer.length} באייט)`);
          break;
        }
      } catch (err) { /* מתעלם ומנסה את הנתיב הבא */ }
    }

    if (!audioBuffer) {
      console.log("❌ שגיאה: לא נמצאה הקלטה תקינה.");
      return res.status(200).type("text/plain").send(`id_list_message=t-לא נמצאה הקלטה תקינה אנא הקלט שוב&go_to_folder=/1`);
    }

    let transcribedText = "";
    if (deepgramApiKey) {
      try {
        console.log("🎙️ מעביר ל-Deepgram (Nova-3)...");
        const dgResponse = await axios.post("https://api.deepgram.com/v1/listen?language=he&model=nova-3", audioBuffer, {
          headers: { "Authorization": `Token ${deepgramApiKey}`, "Content-Type": "audio/wav" },
          timeout: 10000
        });
        transcribedText = (dgResponse.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim();
        console.log(`📝 [Deepgram]: "${transcribedText}"`);
      } catch (err) {
        console.error("❌ שגיאה בתמלול Deepgram, מעביר ל-Gemini:", err.response?.data || err.message);
      }
    }

    const normalizedTranscription = normalizeText(transcribedText);

    // בדיקת מילים אסורות
    if (BLOCKED_KEYWORDS.some(keyword => normalizedTranscription.includes(keyword))) {
      userSession.blockedAttempts += 1;
      console.log(`🛑 תוכן לא ראוי! אזהרה ${userSession.blockedAttempts}/3 למספר ${userPhone}`);

      if (userSession.blockedAttempts >= 3) {
        await blockUserPermanently(userPhone);
        return res.status(200).type("text/plain").send(`id_list_message=t-${BANNED_USER_RESPONSE}&go_to_folder=/1`);
      }

      conversationHistory.set(userPhone, userSession);
      return res.status(200).type("text/plain").send(`id_list_message=t-${getWarningMessage(userSession.blockedAttempts)}&go_to_folder=/1`);
    }

    // איפוס שיחה
    if (RESET_TRIGGERS.some(trigger => normalizedTranscription.includes(trigger))) {
      console.log("🔄 זוהתה בקשת איפוס שיחה!");
      userSession.history = [];
      conversationHistory.set(userPhone, userSession);
      return res.status(200).type("text/plain").send(`id_list_message=t-השיחה אופסה בהצלחה במה אוכל לעזור&go_to_folder=/1`);
    }

    const isDeepRequested = DEEP_DETAILS_TRIGGERS.some(trigger => normalizedTranscription.includes(trigger));
    let finalAnswerText = "";
    
    const basePersonality = "אתה עוזר קולי יעיל. כאשר שואלים אותך מה חדש חדשות או שאלות עובדתיות ענה באופן עובדתי ואינפורמטיבי. כלל ברזל חשוב: אם המשתמש שואל שאלה בעלת אופי מיני בוטה שוביניסטי או תוכן לא ראוי ענה אך ורק במילים המפתחים שלי הגדירו לי שאסור לי לענות על זה. לעולם אל תשתמש בסימני פיסוק. אל תאמר שאין לך גישה לאינטרנט או שאתה מודל שפה. אם נדרשת מילה באנגלית הפרד את האותיות ברווחים.";
    const systemInstruction = isDeepRequested
      ? `${basePersonality} המשתמש ביקש שתתעמק ותפרט. ענה בצורה מפורטת ומורחבת עד 120 מילים סהכ.`
      : `${basePersonality} ענה בציטוט קצר ותמציתי עד 35 מילים בלבד.`;

    const isTranscriptionWeak = !transcribedText || transcribedText.split(" ").length < 2;
    const needsSearch = /חפש|חפשי|מה חדש|חדשות|עדכון|עדכונים|היום/i.test(normalizedTranscription);

    // --- שלב 1: Gemini Direct ---
    if (geminiKeys.length > 0 && !finalAnswerText) {
      const geminiModels = requestedModel ? [requestedModel, "gemini-2.5-flash", "gemini-2.5-flash-lite"] : ["gemini-2.5-flash-lite", "gemini-2.5-flash"];
      const geminiContents = [
        { role: "user", parts: [{ text: systemInstruction }] },
        { role: "model", parts: [{ text: "מבין עונה לפי ההנחיות והערכים הנדרשים." }] }
      ];

      userSession.history.forEach((msg) => {
        geminiContents.push({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: msg.content }] });
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

      for (const apiKey of geminiKeys) {
        if (finalAnswerText) break;
        
        // הגנה פר-מפתח (מונע קריסה של כל השרת בגלל 429 על מפתח בודד)
        const cooldownEnd = geminiKeyCooldowns.get(apiKey) || 0;
        if (Date.now() < cooldownEnd) continue;

        for (const model of geminiModels) {
          try {
            console.log(`🤖 מנסה Gemini | מודל ${model}...`);
            const response = await callGeminiSimple(model, payload, apiKey);
            if (response?.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
              finalAnswerText = response.data.candidates[0].content.parts[0].text;
              if (isTranscriptionWeak) transcribedText = "[שמע שפוענח ישירות ע״י Gemini]";
              break;
            }
          } catch (err) {
            const statusCode = err.response?.status;
            if (statusCode === 429) {
              geminiKeyCooldowns.set(apiKey, Date.now() + 10 * 60 * 1000);
              console.log(`⛔ חריגת מכסה 429 במפתח! מפעיל הפוגה של 10 דקות עבורו.`);
            }
          }
        }
      }
    }

    // --- שלב 2: גיבוי OpenRouter ---
    if (!finalAnswerText && openRouterKeys.length > 0 && transcribedText.length > 0 && !transcribedText.startsWith("[שמע")) {
      const messagesPayload = [{ role: "system", content: systemInstruction }, ...userSession.history, { role: "user", content: transcribedText }];

      for (const orKey of openRouterKeys) {
        if (finalAnswerText) break;
        try {
          console.log(`🌐 מנסה OpenRouter...`);
          const openRouterCompletion = await axios.post("https://openrouter.ai/api/v1/chat/completions", 
            { model: "openrouter/free", messages: messagesPayload, temperature: 0.3 },
            { headers: { "Authorization": `Bearer ${orKey.trim()}`, "Content-Type": "application/json", "HTTP-Referer": "https://yemot-telephony-ai.com" }, timeout: 12000 }
          );
          finalAnswerText = openRouterCompletion.data?.choices?.[0]?.message?.content || "";
        } catch (err) {
          console.log(`❌ שגיאה ב-OpenRouter`);
        }
      }
    }

    if (!finalAnswerText) {
      finalAnswerText = "הגעת למכסה היומית אנא נסה שוב מאוחר יותר";
    }

    // בדיקת חסימת מודל LLM
    const normalizedAnswer = normalizeText(finalAnswerText);
    if (normalizedAnswer.includes(BLOCKED_RESPONSE_MARKER)) {
      userSession.blockedAttempts += 1;
      if (userSession.blockedAttempts >= 3) {
        await blockUserPermanently(userPhone);
        return res.status(200).type("text/plain").send(`id_list_message=t-${BANNED_USER_RESPONSE}&go_to_folder=/1`);
      }
      conversationHistory.set(userPhone, userSession);
      return res.status(200).type("text/plain").send(`id_list_message=t-${getWarningMessage(userSession.blockedAttempts)}&go_to_folder=/1`);
    }

    const cleanText = finalAnswerText.replace(/[,.?!:;'"״׳`_\-*~#–—&?=<>/()\\[\]{}]/g, " ").replace(/\s+/g, " ").trim();
    console.log(`💬 [תשובה מוכנה]: "${cleanText}"`);

    if (transcribedText && !transcribedText.startsWith("[שמע")) {
      userSession.history.push({ role: "user", content: transcribedText });
      userSession.history.push({ role: "assistant", content: cleanText });
      if (userSession.history.length > 6) userSession.history = userSession.history.slice(-6);
      conversationHistory.set(userPhone, userSession);
    }

    return res.status(200).type("text/plain").send(`id_list_message=t-${cleanText}&go_to_folder=/1`);

  } catch (error) {
    console.error("❌ === שגיאה כללית בקוד ===", error.message);
    return res.status(200).type("text/plain").send(`id_list_message=t-חלה שגיאה במערכת אנא נסה שנית&go_to_folder=/1`);
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
