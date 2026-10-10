const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const axios = "axios" in globalThis ? globalThis.axios : require("axios");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

// --- אתחול Supabase למסד הנתונים בענן ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const bannedPhones = new Set();

// טעינת מספרים חסומים מ-Supabase בעליית השרת (כולל לוגים מפורטים)
async function loadBannedPhones() {
  try {
    console.log("🔍 מנסה לטעון מספרים חסומים מ-Supabase (טבלה: bot_storage, מפתח: banned_phones)...");
    const { data, error } = await supabase
      .from('bot_storage')
      .select('value')
      .eq('key', 'banned_phones')
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        console.log("ℹ️ מפתח המספרים החסומים טרם קיים בטבלה (זוהי כנראה הרצה ראשונה). ממשיך רגיל.");
        return;
      }
      console.error("❌ שגיאת Supabase בטעינת מספרים חסומים:", {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
      return;
    }

    if (data && Array.isArray(data.value)) {
      data.value.forEach(phone => bannedPhones.add(String(phone).trim()));
      console.log(`🔒 נטענו בהצלחה ${bannedPhones.size} מספרים חסומים מ-Supabase.`);
    } else {
      console.log("ℹ️ הנתונים שהתקבלו עבור מספרים חסומים אינם מערך תקין:", data);
    }
  } catch (err) {
    console.error("❌ שגיאה חריגה (Exception) בטעינת מספרים חסומים מ-Supabase:", err.message, err.stack);
  }
}

// שמירת מספרים חסומים ל-Supabase (כולל לוגים מפורטים)
async function saveBannedPhones() {
  try {
    const phonesArray = Array.from(bannedPhones);
    console.log(`💾 מנסה לשמור ${phonesArray.length} מספרים חסומים ל-Supabase...`);
    
    const { data, error } = await supabase
      .from('bot_storage')
      .upsert({ key: 'banned_phones', value: phonesArray });
      
    if (error) {
      console.error("❌ שגיאת Supabase בשמירת מספרים חסומים:", {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
      throw error;
    }
    console.log("💾 מספרים חסומים נשמרו בהצלחה ב-Supabase.");
  } catch (err) {
    console.error("❌ שגיאה חריגה (Exception) בשמירת מספרים חסומים ל-Supabase:", err.message);
  }
}

// פונקציית שמירת שיחה לטבלת היסטוריה ב-Supabase (כולל לוגים מפורטים)
async function logConversationToSupabase(phone, question, answer, modelName) {
  try {
    const payload = { phone, question, answer, model: modelName };
    console.log("📝 שולח נתוני שיחה לטבלת conversation_logs ב-Supabase:", payload);

    const { data, error } = await supabase
      .from('conversation_logs')
      .insert([payload]);

    if (error) {
      console.error("❌ שגיאת Supabase ברישום השיחה:", {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
    } else {
      console.log("✅ השיחה נרשמה בהצלחה ב-Supabase.");
    }
  } catch (err) {
    console.error("❌ שגיאה חריגה (Exception) ברישום השיחה ל-Supabase:", err.message);
  }
}

// סנכרון ממשתני סביבה בעליית השרת (אם קיים)
if (process.env.INITIAL_BANNED_PHONES) {
  try {
    const parsedBanned = JSON.parse(process.env.INITIAL_BANNED_PHONES);
    if (Array.isArray(parsedBanned)) {
      parsedBanned.forEach((phone) => {
        bannedPhones.add(String(phone).trim());
      });
      saveBannedPhones();
      console.log(`🔒 סונכרנו ${bannedPhones.size} מספרים חסומים ממשתני הסביבה.`);
    }
  } catch (err) {
    console.error("❌ שגיאה בפענוח INITIAL_BANNED_PHONES:", err.message);
  }
}

const processedCalls = new Map();
const conversationHistory = new Map();
const requestLimits = new Map(); // הגנת Rate Limit לפי מספר טלפון

// פונקציית בדיקת Rate Limit (עד 10 פניות בדקה למספר)
const checkRateLimit = (phone) => {
  if (!phone || phone === "default_user") return true;
  const now = Date.now();
  const userLog = requestLimits.get(phone) || [];
  const recentRequests = userLog.filter(timestamp => now - timestamp < 60000);
  
  if (recentRequests.length >= 10) {
    return false;
  }
  
  recentRequests.push(now);
  requestLimits.set(phone, recentRequests);
  return true;
};

const blockUserPermanently = async (phone) => {
  bannedPhones.add(phone);
  await saveBannedPhones();

  if (conversationHistory.has(phone)) {
    const session = conversationHistory.get(phone);
    if (session.timer) clearTimeout(session.timer);
    conversationHistory.delete(phone);
  }
};

const unblockUser = async (phone) => {
  const existed = bannedPhones.delete(phone);
  if (existed) {
    await saveBannedPhones();
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

    const token = params.token || params.TOKEN || params.ApiToken || params.SessionToken || params.Session_Token || process.env.YM_API_TOKEN;
    const userPhone = params.ApiPhone || params.phone || "default_user";

    if (process.env.SYSTEM_TOKEN && token !== process.env.SYSTEM_TOKEN) {
      console.warn(`Unauthorized access attempt with token: ${token}`);
      return res.status(403).send('Unauthorized Token');
    }

    if (!token) {
      console.log("❌ שגיאה: לא נמצא טוקן (Token) לאימות מול ימות המשיח.");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-שגיאת אימות טוקן חסר&go_to_folder=/1`);
    }

    if (!checkRateLimit(userPhone)) {
      console.warn(`Rate limit exceeded for phone: ${userPhone}`);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-חרגת ממספר הפניות המותר בדקה. נסה שוב מאוחר יותר.&go_to_folder=/1`);
    }

    const callId = params.ApiCallId || params.ApiYFCallId;
    const systemDid = params.ApiRealDID || params.ApiDID || "לא ידוע";
    const secondaryFolder = params.SHL || "1";
    const primaryFolder = params.SHM || "2";
    const requestedModel = params.MODEL || params.model;

    console.log(`📞 [ימות המשיח] פנייה חדשה | DID: ${systemDid} \vert{} טלפון: ${userPhone}`);

    if (callId && processedCalls.has(callId)) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`go_to_folder=/1`);
    }

    if (callId) {
      processedCalls.set(callId, Date.now());
      setTimeout(() => processedCalls.delete(callId), 10000);
    }

    if (bannedPhones.has(userPhone)) {
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

    const directKeys = [
      params.GEMINI_API_KEY, params.gemini_key, params.GeminiKey, params.AI_KEY,
      params.API, params.Api, params.api,
      params.KEY, params.Key, params.key,
      params.KEY2, params.Key2, params.key2,
      params.GEMINI, params.Gemini
    ].filter(Boolean);

    directKeys.forEach(k => {
      const val = String(k).trim();
      if (val) parsedGeminiKeys.add(val);
    });

    const explicitOpenRouter = params.OPENROUTER_API_KEY || params.openrouter_key || params.OpenRouterKey;
    if (explicitOpenRouter) parsedOpenRouterKeys.add(String(explicitOpenRouter).trim());

    const explicitDeepgram = params.DEEPGRAM_API_KEY || params.deepgram_key || params.DeepgramKey || params.DEEPGRAM;
    if (explicitDeepgram) parsedDeepgram = String(explicitDeepgram).trim();

    const extractKeysDeeply = (obj, depth = 0) => {
      if (depth > 5 || !obj) return; 
      for (const value of Object.values(obj)) {
        const items = Array.isArray(value) ? value : [value];
        for (const item of items) {
          if (typeof item === "string") {
            const parts = item.split(/[\s,;|]+/).map(p => p.trim()).filter(Boolean);
            for (const part of parts) {
              if (part.startsWith("AIza") || part.startsWith("QA.A") || part.startsWith("AQ.")) {
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

    let audioBuffer = null;
    const possiblePaths = [];

    if (params.path) possiblePaths.push(params.path);
    if (params.Path) possiblePaths.push(params.Path);
    if (params.file) possiblePaths.push(params.file);
    if (params.File) possiblePaths.push(params.File);
    if (params.ApiPath) possiblePaths.push(params.ApiPath);
    possiblePaths.push(`ivr2:/${secondaryFolder}/last.wav`);
    possiblePaths.push(`ivr2:/${primaryFolder}/last.wav`);

    for (let rawPath of possiblePaths) {
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;

      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 8000 });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          break;
        }
      } catch (err) {}
    }

    if (!audioBuffer) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-לא נמצאה הקלטה תקינה אנא הקלט שוב&go_to_folder=/1`);
    }

    let transcribedText = "";

    if (deepgramApiKey) {
      try {
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
      } catch (err) {}
    }

    const normalizedTranscription = normalizeText(transcribedText);

    const isBlocked = BLOCKED_KEYWORDS.some(keyword => normalizedTranscription.includes(keyword));
    if (isBlocked) {
      userSession.blockedAttempts += 1;
      if (userSession.blockedAttempts >= 3) {
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

    const isResetRequested = RESET_TRIGGERS.some(trigger => normalizedTranscription.includes(trigger));
    if (isResetRequested) {
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
    let usedModelName = "unknown";
    
    const basePersonality = "אתה עוזר קולי יעיל שמחובר לרשת האינטרנט. כאשר שואלים אותך מה חדש חדשות אירועים שאלות עובדתיות או בקשות חיפוש השתמש בכלי החיפוש וענה מיד באופן עובדתי ומדויק. לעולם אל תגיד שאין לך גישה לאינטרנט או שאתה לא יכול לחפש בזמן אמת. כלל ברזל: אם המשתמש שואל שאלה בעלת אופי מיני בוטה שוביניסטי או תוכן לא ראוי ענה אך ורק במילים המפתחים שלי הגדירו לי שאסור לי לענות על זה. לעולם אל תשתמש בסימני פיסוק. אם נדרשת מילה באנגלית הפרד את האותיות ברווחים.";
    
    const systemInstruction = isDeepRequested
      ? `${basePersonality} המשתמש ביקש שתתעמק ותפרט. ענה בצורה מפורטת ומורחבת עד 120 מילים סהכ.`
      : `${basePersonality} ענה בציטוט קצר ותמציתי עד 35 מילים בלבד.`;

    const isTranscriptionWeak = !transcribedText || transcribedText.split(" ").length < 2;
    const lowerTranscription = transcribedText.toLowerCase();

    const SEARCH_KEYWORDS = ["חפש", "חדשות", "עדכון", "היום", "מי", "מה", "איפה", "מתי", "כמה", "איך", "תוצאות", "מזג אוויר", "תוצאה", "מחיר"];
    const needsSearch = isTranscriptionWeak || SEARCH_KEYWORDS.some(word => lowerTranscription.includes(word));

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
            const response = await callGeminiSimple(model, payload, apiKey);
            if (response?.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
              finalAnswerText = response.data.candidates[0].content.parts[0].text;
              usedModelName = `gemini (${model})`;
              if (isTranscriptionWeak) transcribedText = "[שמע שפוענח ישירות ע״י Gemini]";
              break;
            }
          } catch (err) {
            if (err.response?.status === 429) {
              console.warn(`⚠️ Gemini API 429 (Rate Limit). מפעיל הדרגתיות להגבלת בקשות...`);
              geminiCooldownUntil = Date.now() + 10 * 60 * 1000;
            }
            console.error(`❌ שגיאה בקריאה ל-Gemini (${model}):`, err.message);
          }
        }
      }
    }

    if (!finalAnswerText) {
      finalAnswerText = "הגעת למכסה היומית אנא נסה שוב מאוחר יותר";
      usedModelName = "system-fallback";
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

    const cleanText = finalAnswerText.replace(/[,.?!:;'"״׳`_\-*~#–—&?=<>/()\\[\]{}]/g, " ").replace(/\s+/g, " ").trim();

    logConversationToSupabase(userPhone, transcribedText, cleanText, usedModelName);

    if (transcribedText && !transcribedText.startsWith("[שמע")) {
      userSession.history.push({ role: "user", content: transcribedText });
      userSession.history.push({ role: "assistant", content: cleanText });
      if (userSession.history.length > 6) userSession.history = userSession.history.slice(-6);
      conversationHistory.set(userPhone, userSession);
    }

    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-${cleanText}&go_to_folder=/1`);

  } catch (error) {
    console.error("❌ === שגיאה כללית בקוד ===", error.message, error.stack);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-חלה שגיאה במערכת אנא נסה שנית&go_to_folder=/1`);
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

loadBannedPhones().then(() => {
  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});
