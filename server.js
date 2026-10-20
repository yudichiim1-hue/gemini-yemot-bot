const express = require("express");
const axios = "axios" in globalThis ? globalThis.axios : require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

const bannedPhones = new Set();

if (process.env.INITIAL_BANNED_PHONES) {
  try {
    const parsedBanned = JSON.parse(process.env.INITIAL_BANNED_PHONES);
    if (Array.isArray(parsedBanned)) {
      parsedBanned.forEach((phone) => bannedPhones.add(String(phone).trim()));
      console.log(`🔒 סונכרנו ${bannedPhones.size} מספרים חסומים ממשתני הסביבה.`);
    }
  } catch (err) {
    console.error("❌ שגיאה בפענוח INITIAL_BANNED_PHONES:", err.message);
  }
}

const processedCalls = new Map();
const conversationHistory = new Map();
const requestLimits = new Map();

const checkRateLimit = (phone) => {
  if (!phone || phone === "default_user") return true;
  const now = Date.now();
  const userLog = requestLimits.get(phone) || [];
  const recentRequests = userLog.filter(timestamp => now - timestamp < 60000);
  
  if (recentRequests.length >= 10) {
    console.warn(`⚠️ Rate limit חורג למספר: ${phone}`);
    return false;
  }
  
  recentRequests.push(now);
  requestLimits.set(phone, recentRequests);
  return true;
};

const blockUserPermanently = (phone) => {
  console.log(`🚨 חוסם לצמיתות את המספר: ${phone}`);
  bannedPhones.add(phone);
  if (conversationHistory.has(phone)) {
    const session = conversationHistory.get(phone);
    if (session.timer) clearTimeout(session.timer);
    conversationHistory.delete(phone);
  }
};

setInterval(() => {
  const now = Date.now();
  console.log("🧹 מריץ ניקוי תקופתי של היסטוריות שיחות ישנות...");
  for (const [phone, session] of conversationHistory.entries()) {
    if (session.lastActive && now - session.lastActive > 10 * 60 * 1000) {
      if (session.timer) clearTimeout(session.timer);
      conversationHistory.delete(phone);
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

const RESET_TRIGGERS = [
  "תתחיל מחדש", "תתחילי מחדש", "אפס שיחה", "איפוס שיחה",
  "שיחה חדשה", "התחל מחדש", "תמחק היסטוריה", "ניקוי היסטוריה"
].map(normalizeText);

const DEEP_DETAILS_TRIGGERS = [
  "תתעמק", "תתעמקי", "תרחיב", "תרחיבי", "בהרחבה",
  "תפרט", "תפרטי", "עוד מידע", "פירוט", "מידע מפורט"
].map(normalizeText);

const SWITCH_TO_ENGLISH_TRIGGERS = [
  "עבור לאנגלית", "דבר אנגלית", "אנגלית", "switch to english", "english please", "speak english"
].map(normalizeText);

const SWITCH_TO_HEBREW_TRIGGERS = [
  "עבור לעברית", "דבר עברית", "עברית", "switch to hebrew", "hebrew please", "speak hebrew"
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

function sendYemotTtsResponse(res, text, nextFolder = "1") {
  const clean = (text || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[,.?!:;'"״׳`_\-*~#–—&?=<>/()\\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  console.log(`🔊 מחזיר מענה קולי לימות המשיח (שלוחה /${nextFolder}): "${clean}"`);
  res.set("Content-Type", "text/plain; charset=utf-8");
  return res.send(`id_list_message=t-${clean}&go_to_folder=/${nextFolder}`);
}

const callGeminiSimple = async (model, payload, geminiApiKey) => {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
  return axios.post(geminiUrl, payload, { 
    headers: { "Content-Type": "application/json" }, 
    timeout: 12000 
  });
};

async function downloadAndUploadToYemot(targetInput, token, targetFolder = "3") {
  const tempFilePath = path.join(__dirname, `temp_song_${Date.now()}.mp3`);

  try {
    let videoUrl = targetInput;
    let videoId = "";

    const match = targetInput.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
    if (match && match[1]) {
      videoId = match[1];
      videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      console.log(`📌 חולץ מזהה סרטון סידורי: ${videoId}`);
    } else if (!targetInput.startsWith("http://") && !targetInput.startsWith("https://")) {
      videoUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(targetInput)}`;
    }

    console.log(`🎵 מתחיל הורדת שמע עבור: ${videoUrl}`);

    // שימוש ב-API אמין של Cobalt להורדה ישירה ללא הפניות
    const cobaltRes = await axios.post("https://api.cobalt.tools/api/json", {
      url: videoUrl,
      downloadMode: "audio",
      audioFormat: "mp3"
    }, {
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      timeout: 25000
    });

    let downloadDirectUrl = cobaltRes.data?.url;

    if (!downloadDirectUrl) {
      throw new Error("שירות Cobalt לא החזיר קישור הורדה תקין.");
    }

    console.log("📥 מוריד את קובץ השמע מקישור ה-Stream הישיר...");

    const audioFileRes = await axios.get(downloadDirectUrl, { 
      responseType: "stream",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      timeout: 40000 
    });

    const writer = fs.createWriteStream(tempFilePath);
    audioFileRes.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    // וידוא תקינות: בדיקת גודל הקובץ הנוצר בשרת
    const stats = fs.statSync(tempFilePath);
    const fileSizeInBytes = stats.size;
    console.log(`📏 גודל הקובץ שהורד: ${(fileSizeInBytes / 1024).toFixed(2)} KB`);

    if (fileSizeInBytes < 200 * 1024) { // פחות מ-200KB פירושו קובץ טקסט/שגיאה
      throw new Error(`קובץ השמע שהורד קטן מדי (${(fileSizeInBytes / 1024).toFixed(2)} KB), כנראה מדובר בעמוד שגיאה.`);
    }

    console.log(`⬆️ מעלה את השיר לשלוחה /${targetFolder} בימות המשיח...`);

    const form = new FormData();
    form.append("file", fs.createReadStream(tempFilePath));

    const uploadUrl = `https://www.call2all.co.il/ym/api/UploadFile?token=${token}&path=ivr2:/${targetFolder}/000.mp3`;

    const uploadRes = await axios.post(uploadUrl, form, {
      headers: form.getHeaders(),
      timeout: 30000
    });

    console.log("📤 תשובת העלאה מימות המשיח:", uploadRes.data);

    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

    console.log("✅ השיר הועלה בהצלחה לשלוחה!");
    return true;
  } catch (err) {
    console.error("❌ שגיאה בהורדה או בהעלאת השיר:", err.message);
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    return false;
  }
}

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };

    const token = params.token || params.TOKEN || params.ApiToken || params.SessionToken || params.Session_Token || process.env.YM_API_TOKEN;
    const userPhone = params.ApiPhone || params.phone || "default_user";

    if (process.env.SYSTEM_TOKEN && token !== process.env.SYSTEM_TOKEN) {
      console.warn(`⚠️ ניסיון גישה עם טוקן שגוי: ${token}`);
      return res.status(403).send('Unauthorized Token');
    }

    if (!token) {
      console.error("❌ שגיאה: לא נמצא טוקן (Token) לאימות מול ימות המשיח.");
      return sendYemotTtsResponse(res, "שגיאת אימות טוקן חסר");
    }

    if (!checkRateLimit(userPhone)) {
      return sendYemotTtsResponse(res, "חרגת ממספר הפניות המותר בדקה נסה שוב מאוחר יותר");
    }

    const callId = params.ApiCallId || params.ApiYFCallId;
    const systemDid = params.ApiRealDID || params.ApiDID || "לא ידוע";
    const secondaryFolder = params.SHL || "1";
    const primaryFolder = params.SHM || "2";
    const requestedModel = params.MODEL || params.model;

    console.log(`📞 [ימות המשיח] פנייה חדשה | DID: ${systemDid} | טלפון: ${userPhone}`);

    if (callId && processedCalls.has(callId)) {
      console.log(`🔄 שיחה כפולה זוהתה (CallId: ${callId}), מתעלם.`);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`go_to_folder=/1`);
    }

    if (callId) {
      processedCalls.set(callId, Date.now());
      setTimeout(() => processedCalls.delete(callId), 10000);
    }

    if (bannedPhones.has(userPhone)) {
      console.log(`🚫 משתמש חסום ניסה להתחבר: ${userPhone}`);
      return sendYemotTtsResponse(res, BANNED_USER_RESPONSE);
    }

    let userSession = conversationHistory.get(userPhone) || { 
      history: [], 
      timer: null, 
      lastActive: Date.now(),
      blockedAttempts: 0,
      language: "he"
    };

    const parsedGeminiKeys = new Set([process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_1].filter(Boolean));
    const parsedOpenAIKeys = new Set([process.env.OPENAI_API_KEY, process.env.OPENAI_API_KEY_1].filter(Boolean));
    const parsedOpenRouterKeys = new Set([process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY_1].filter(Boolean));
    let parsedDeepgram = process.env.DEEPGRAM_API_KEY || "";

    const directGemini = params.GEMINI_API_KEY || params.gemini_key || params.GeminiKey || params.AI_KEY || params.API || params.Api || params.api || params.KEY || params.Key || params.key || params.GEMINI;
    if (directGemini) parsedGeminiKeys.add(String(directGemini).trim());

    const directOpenAI = params.OPENAI || params.openai || params.OPENAI_API_KEY || params.openai_key || params.OpenAIKey;
    if (directOpenAI) parsedOpenAIKeys.add(String(directOpenAI).trim());

    const directOpenRouter = params.OPENROUTER || params.openrouter || params.OPENROUTER_API_KEY || params.openrouter_key || params.OpenRouterKey;
    if (directOpenRouter) parsedOpenRouterKeys.add(String(directOpenRouter).trim());

    const directDeepgram = params.DEEPGRAM || params.deepgram || params.DEEPGRAM_API_KEY || params.deepgram_key || params.DeepgramKey;
    if (directDeepgram) parsedDeepgram = String(directDeepgram).trim();

    const extractKeysDeeply = (obj, depth = 0) => {
      if (depth > 5 || !obj) return; 
      for (const value of Object.values(obj)) {
        const items = Array.isArray(value) ? value : [value];
        for (const item of items) {
          if (typeof item === "string") {
            const parts = item.split(/[\s,;|]+/).map(p => p.trim()).filter(Boolean);
            for (const part of parts) {
              if (part.startsWith("AIza") || part.startsWith("AQ.")) parsedGeminiKeys.add(part);
              else if (part.startsWith("sk-proj-") || (part.startsWith("sk-") && !part.startsWith("sk-or-"))) parsedOpenAIKeys.add(part);
              else if (part.startsWith("sk-or-")) parsedOpenRouterKeys.add(part);
              else if (part.length === 40 && /^[a-f0-9]{40}$/i.test(part)) parsedDeepgram = part;
            }
          } else if (typeof item === "object" && item !== null) {
            extractKeysDeeply(item, depth + 1);
          }
        }
      }
    };

    extractKeysDeeply(params);

    const geminiKeys = Array.from(parsedGeminiKeys);
    const openAIKeys = Array.from(parsedOpenAIKeys);
    const openRouterKeys = Array.from(parsedOpenRouterKeys);
    const deepgramApiKey = parsedDeepgram.trim();

    console.log(`🔑 מפתחות זוהו במערכת -> Gemini: ${geminiKeys.length} | OpenAI: ${openAIKeys.length} | OpenRouter: ${openRouterKeys.length} | Deepgram: ${deepgramApiKey ? 'כן' : 'לא'}`);

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
          console.log(`📥 קובץ שמע הורד בהצלחה מנתיב: ${cleanPath}`);
          break;
        }
      } catch (err) {}
    }

    if (!audioBuffer) {
      console.warn("⚠️ לא נמצא קובץ שמע להורדה.");
      return sendYemotTtsResponse(res, "לא נמצאה הקלטה תקינה אנא הקלט שוב");
    }

    let transcribedText = "";

    if (deepgramApiKey) {
      try {
        const currentLang = userSession.language || "he";
        console.log(`🎙️ שולח קובץ שמע לתמלול ב-Deepgram (שפה נוכחית: ${currentLang})...`);
        const dgResponse = await axios.post(
          `https://api.deepgram.com/v1/listen?language=${currentLang}&model=nova-3&smart_format=true`,
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
        console.log(`📝 תוצאת תמלול Deepgram: "${transcribedText}"`);
      } catch (err) {
        console.error("❌ שגיאה בתמלול Deepgram:", err.message);
      }
    }

    if (!transcribedText || transcribedText.length < 1) {
      console.log(`⚠️ תמלול ריק לחלוטין. דורש הקלטה חוזרת.`);
      return sendYemotTtsResponse(res, userSession.language === "en" ? "Please speak clearly" : "אנא דבר יותר לאט וברור");
    }

    const normalizedTranscription = normalizeText(transcribedText);

    if (SWITCH_TO_ENGLISH_TRIGGERS.some(trigger => normalizedTranscription.includes(trigger))) {
      console.log(`🌐 משתמש ${userPhone} ביקש לעבור לאנגלית.`);
      userSession.language = "en";
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, "Switched to English. How can I help you?");
    }

    if (SWITCH_TO_HEBREW_TRIGGERS.some(trigger => normalizedTranscription.includes(trigger))) {
      console.log(`🌐 משתמש ${userPhone} ביקש לעבור לעברית.`);
      userSession.language = "he";
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, "עברנו חזרה לעברית במה אוכל לעזור");
    }

    if (BLOCKED_KEYWORDS.some(keyword => normalizedTranscription.includes(keyword))) {
      console.warn(`⚠️ זיהו מילה חסומה בתמלול של המשתמש: ${userPhone}`);
      userSession.blockedAttempts += 1;
      if (userSession.blockedAttempts >= 3) {
        blockUserPermanently(userPhone);
        return sendYemotTtsResponse(res, BANNED_USER_RESPONSE);
      }

      userSession.lastActive = Date.now();
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, getWarningMessage(userSession.blockedAttempts));
    }

    if (RESET_TRIGGERS.some(trigger => normalizedTranscription.includes(trigger))) {
      console.log(`🔄 משתמש ${userPhone} ביקש איפוס שיחה.`);
      conversationHistory.set(userPhone, {
        history: [],
        timer: null,
        lastActive: Date.now(),
        blockedAttempts: userSession.blockedAttempts,
        language: "he"
      });
      return sendYemotTtsResponse(res, "השיחה אופסה בהצלחה במה אוכל לעזור");
    }

    const isDeepRequested = DEEP_DETAILS_TRIGGERS.some(trigger => normalizedTranscription.includes(trigger));

    if (userSession.timer) clearTimeout(userSession.timer);
    userSession.lastActive = Date.now();
    userSession.timer = setTimeout(() => {
      conversationHistory.delete(userPhone);
    }, 10 * 60 * 1000);

    let finalAnswerText = "";
    let usedModelName = "unknown";
    
    const basePersonalityHebrew = "אתה עוזר קולי יעיל שמחובר לרשת האינטרנט. כאשר שואלים אותך מה חדש חדשות אירועים שאלות עובדתיות או בקשות חיפוש השתמש בכלי החיפוש וענה מיד באופן עובדתי ומדויק. לעולם אל תגיד שאין לך גישה לאינטרנט או שאתה לא יכול לחפש בזמן אמת. כלל ברזל חשוב: אם המשתמש מבקש לשמוע שיר להוריד שיר או להשמיע מוזיקה, חפש באמצעות כלי החיפוש את השיר ביוטיוב והחזר אך ורק את הקישור הישיר אליו בפורמט: PLAY_SONG: [קישור יוטיוב מלא]. בכל מקרה אחר: ענה רגיל וללא סימני פיסוק ובסוף כל תשובה סיים בשאלת המשך קצרה. אם השאלה לא ראויה ענה אך ורק: המפתחים שלי הגדירו לי שאסור לי לענות על זה.";
    const basePersonalityEnglish = "You are a helpful voice assistant connected to the internet. Always answer factually and accurately using web search when needed. If the user asks to play or download a song, search for it and reply ONLY with the direct YouTube URL in format: PLAY_SONG: [full youtube url]. Never use punctuation marks. Always end every response with a short relevant follow up question.";

    const selectedBasePersonality = userSession.language === "en" ? basePersonalityEnglish : basePersonalityHebrew;

    const systemInstruction = isDeepRequested
      ? `${selectedBasePersonality} ${userSession.language === "en" ? "Elaborate in up to 130 words." : "המשתמש ביקש שתתעמק ותפרט. ענה בצורה מפורטת ומורחבת עד 130 מילים סהכ."}`
      : `${selectedBasePersonality} ${userSession.language === "en" ? "Answer concisely in up to 45 words." : "ענה בציטוט קצר ותמציתי עד 45 מילים בלבד."}`;

    const lowerTranscription = transcribedText.toLowerCase();
    const SEARCH_KEYWORDS = ["חפש", "חדשות", "עדכון", "היום", "מי", "מה", "איפה", "מתי", "כמה", "איך", "תוצאות", "מזג אוויר", "תוצאה", "מחיר", "שיר", "להשמיע", "להוריד", "נגן", "search", "news", "today", "who", "what", "where", "when", "how", "song", "play", "music"];
    const needsSearch = SEARCH_KEYWORDS.some(word => lowerTranscription.includes(word));

    if (geminiKeys.length > 0) {
      const geminiModels = requestedModel 
        ? [requestedModel, "gemini-2.5-flash-lite", "gemini-2.5-flash"] 
        : ["gemini-2.5-flash-lite", "gemini-2.5-flash"];

      const geminiContents = [
        { role: "user", parts: [{ text: systemInstruction }] },
        { role: "model", parts: [{ text: "Understood. Responding according to guidelines." }] }
      ];

      userSession.history.forEach((msg) => {
        geminiContents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }]
        });
      });

      geminiContents.push({ role: "user", parts: [{ text: transcribedText }] });

      const payload = { contents: geminiContents };
      if (needsSearch) payload.tools = [{ googleSearch: {} }];

      console.log(`🤖 [עדיפות 1] מנסה Gemini (${geminiKeys.length} מפתחות)...`);

      for (let k = 0; k < geminiKeys.length; k++) {
        if (finalAnswerText) break;
        const apiKey = geminiKeys[k];
        for (const model of geminiModels) {
          try {
            console.log(`📡 מנסה Gemini ${model} (מפתח ${k + 1})...`);
            const response = await callGeminiSimple(model, payload, apiKey);
            if (response?.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
              finalAnswerText = response.data.candidates[0].content.parts[0].text;
              usedModelName = `gemini (${model})`;
              console.log(`✅ הצלחה מול Gemini (${model})!`);
              break;
            }
          } catch (err) {
            console.error(`❌ שגיאה ב-Gemini (${model}):`, err.message);
          }
        }
      }
    }

    if (!finalAnswerText && openAIKeys.length > 0) {
      console.log(`🤖 [עדיפות 2] מנסה OpenAI (${openAIKeys.length} מפתחות)...`);
      const openAiPayload = {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemInstruction },
          ...userSession.history.map(m => ({ role: m.role, content: m.content })),
          { role: "user", content: transcribedText }
        ]
      };

      for (const oaKey of openAIKeys) {
        if (finalAnswerText) break;
        try {
          console.log("📡 שולח בקשה ל-OpenAI (gpt-4o-mini)...");
          const oaResponse = await axios.post("https://api.openai.com/v1/chat/completions", openAiPayload, {
            headers: {
              "Authorization": `Bearer ${oaKey}`,
              "Content-Type": "application/json"
            },
            timeout: 12000
          });
          if (oaResponse?.data?.choices?.[0]?.message?.content) {
            finalAnswerText = oaResponse.data.choices[0].message.content;
            usedModelName = "openai (gpt-4o-mini)";
            console.log("✅ הצלחה מול OpenAI!");
            break;
          }
        } catch (oaErr) {
          console.error("❌ שגיאה בקריאה ל-OpenAI:", oaErr.message);
        }
      }
    }

    if (!finalAnswerText && openRouterKeys.length > 0) {
      console.log(`🤖 [עדיפות 3] מנסה OpenRouter...`);
      const openRouterPayload = {
        model: "openrouter/auto",
        messages: [
          { role: "system", content: systemInstruction },
          ...userSession.history.map(m => ({ role: m.role, content: m.content })),
          { role: "user", content: transcribedText }
        ]
      };

      for (const orKey of openRouterKeys) {
        if (finalAnswerText) break;
        try {
          console.log("📡 שולח בקשה ל-OpenRouter...");
          const orResponse = await axios.post("https://openrouter.ai/api/v1/chat/completions", openRouterPayload, {
            headers: {
              "Authorization": `Bearer ${orKey}`,
              "Content-Type": "application/json"
            },
            timeout: 12000
          });
          if (orResponse?.data?.choices?.[0]?.message?.content) {
            finalAnswerText = orResponse.data.choices[0].message.content;
            usedModelName = "openrouter (auto-free)";
            console.log("✅ הצלחה מול OpenRouter!");
            break;
          }
        } catch (orErr) {
          console.error("❌ שגיאה בקריאה ל-OpenRouter:", orErr.message);
        }
      }
    }

    if (!finalAnswerText) {
      console.warn("⚠️ כל המודלים כשלו או הגיעו למכסה.");
      finalAnswerText = userSession.language === "en" ? "Daily limit reached please try again later" : "הגעת למכסה היומית אנא נסה שוב מאוחר יותר";
      usedModelName = "system-fallback";
    }

    if (finalAnswerText.includes("PLAY_SONG:")) {
      const songTarget = finalAnswerText.split("PLAY_SONG:")[1].trim();
      console.log(`🎵 ה-AI זיהה בקשת שיר (יעד: "${songTarget}"). מתחיל הורדה והעלאה לשלוחה /3...`);

      const success = await downloadAndUploadToYemot(songTarget, token, "3");

      if (success) {
        return sendYemotTtsResponse(res, "השיר מוכן מעביר אותך לשלוחת השירים", "3");
      } else {
        return sendYemotTtsResponse(res, "מצטער לא הצלחתי להוריד את השיר מיוטיוב אנא נסה שוב");
      }
    }

    const normalizedAnswer = normalizeText(finalAnswerText);
    if (normalizedAnswer.includes(BLOCKED_RESPONSE_MARKER)) {
      console.warn(`⚠️ תשובת המודל הכילה חסימה עבור משתמש ${userPhone}`);
      userSession.blockedAttempts += 1;
      if (userSession.blockedAttempts >= 3) {
        blockUserPermanently(userPhone);
        return sendYemotTtsResponse(res, BANNED_USER_RESPONSE);
      }
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, getWarningMessage(userSession.blockedAttempts));
    }

    userSession.history.push({ role: "user", content: transcribedText });
    userSession.history.push({ role: "assistant", content: finalAnswerText });
    if (userSession.history.length > 6) userSession.history = userSession.history.slice(-6);
    conversationHistory.set(userPhone, userSession);

    return sendYemotTtsResponse(res, finalAnswerText);

  } catch (error) {
    console.error("❌ === שגיאה כללית בקוד ===", error.message, error.stack);
    return sendYemotTtsResponse(res, "חלה שגיאה במערכת אנא נסה שנית");
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
