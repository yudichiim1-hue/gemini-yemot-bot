const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const axios = "axios" in globalThis ? globalThis.axios : require("axios");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

// --- אתחול Supabase ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const bannedPhones = new Set();

// טעינת מספרים חסומים מ-Supabase
async function loadBannedPhones() {
  try {
    console.log("🔍 מנסה לטעון מספרים חסומים מ-Supabase...");
    const { data, error } = await supabase
      .from('bot_storage')
      .select('value')
      .eq('key', 'banned_phones')
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        console.log("ℹ️ מפתח המספרים החסומים טרם קיים בטבלה. ממשיך רגיל.");
        return;
      }
      console.error("❌ שגיאת Supabase בטעינת מספרים חסומים:", error.message);
      return;
    }

    if (data && Array.isArray(data.value)) {
      data.value.forEach(phone => bannedPhones.add(String(phone).trim()));
      console.log(`🔒 נטענו בהצלחה ${bannedPhones.size} מספרים חסומים מ-Supabase.`);
    }
  } catch (err) {
    console.error("❌ שגיאה חריגה בטעינת מספרים חסומים:", err.message);
  }
}

// שמירת מספרים חסומים ל-Supabase
async function saveBannedPhones() {
  try {
    const phonesArray = Array.from(bannedPhones);
    console.log(`💾 שומר ${phonesArray.length} מספרים חסומים ל-Supabase...`);
    const { error } = await supabase
      .from('bot_storage')
      .upsert({ key: 'banned_phones', value: phonesArray });
      
    if (error) throw error;
    console.log("💾 מספרים חסומים נשמרו בהצלחה ב-Supabase.");
  } catch (err) {
    console.error("❌ שגיאה בשמירת מספרים חסומים:", err.message);
  }
}

// פונקציית שמירת שיחה לטבלת היסטוריה ב-Supabase
async function logConversationToSupabase(phone, question, answer, modelName) {
  try {
    const payload = { phone, question, answer, model: modelName };
    console.log("📝 רושם שיחה ל-Supabase:", payload);
    const { error } = await supabase.from('conversation_logs').insert([payload]);
    if (error) {
      console.error("❌ שגיאה ברישום השיחה ל-Supabase:", error.message);
    } else {
      console.log("✅ השיחה נרשמה בהצלחה ב-Supabase.");
    }
  } catch (err) {
    console.error("❌ שגיאה חריגה ברישום השיחה ל-Supabase:", err.message);
  }
}

if (process.env.INITIAL_BANNED_PHONES) {
  try {
    const parsedBanned = JSON.parse(process.env.INITIAL_BANNED_PHONES);
    if (Array.isArray(parsedBanned)) {
      parsedBanned.forEach((phone) => bannedPhones.add(String(phone).trim()));
      saveBannedPhones();
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

const blockUserPermanently = async (phone) => {
  console.log(`🚨 חוסם לצמיתות את המספר: ${phone}`);
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
    console.log(`🔓 מסיר חסימה מהמספר: ${phone}`);
    await saveBannedPhones();
  }
  return existed;
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

function sendYemotTtsResponse(res, text) {
  const clean = (text || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[,.?!:;'"״׳`_\-*~#–—&?=<>/()\\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  console.log(`🔊 מחזיר מענה קולי לימות המשיח: "${clean}"`);
  res.set("Content-Type", "text/plain; charset=utf-8");
  return res.send(`id_list_message=t-${clean}&go_to_folder=/1`);
}

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
      blockedAttempts: 0 
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
        console.log("🎙️ שולח קובץ שמע לתמלול ב-Deepgram...");
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
        console.log(`📝 תוצאת תמלול Deepgram: "${transcribedText}"`);
      } catch (err) {
        console.error("❌ שגיאה בתמלול Deepgram:", err.message);
      }
    }

    // --- בדיקת איכות תמלול ---
    const transcriptionWords = transcribedText.split(/\s+/).filter(Boolean);
    if (!transcribedText || transcriptionWords.length < 2) {
      console.log(`⚠️ תמלול חלש או ריק מדי (${transcriptionWords.length} מילים). דורש הקלטה חוזרת.`);
      return sendYemotTtsResponse(res, "אנא דבר יותר לאט וברור");
    }

    const normalizedTranscription = normalizeText(transcribedText);

    if (BLOCKED_KEYWORDS.some(keyword => normalizedTranscription.includes(keyword))) {
      console.warn(`⚠️ זיהו מילה חסומה בתמלול של המשתמש: ${userPhone}`);
      userSession.blockedAttempts += 1;
      if (userSession.blockedAttempts >= 3) {
        await blockUserPermanently(userPhone);
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
        blockedAttempts: userSession.blockedAttempts
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
    
    const basePersonality = "אתה עוזר קולי יעיל שמחובר לרשת האינטרנט. כאשר שואלים אותך מה חדש חדשות אירועים שאלות עובדתיות או בקשות חיפוש השתמש בכלי החיפוש וענה מיד באופן עובדתי ומדויק. לעולם אל תגיד שאין לך גישה לאינטרנט או שאתה לא יכול לחפש בזמן אמת. כלל ברזל: אם המשתמש שואל שאלה בעלת אופי מיני בוטה שוביניסטי או תוכן לא ראוי ענה אך ורק במילים המפתחים שלי הגדירו לי שאסור לי לענות על זה. לעולם אל תשתמש בסימני פיסוק. בסוף כל תשובה סיים בשאלת המשך קצרה ורלוונטית שקשורה ישירות לנושא השיחה.";
    
    const systemInstruction = isDeepRequested
      ? `${basePersonality} המשתמש ביקש שתתעמק ותפרט. ענה בצורה מפורטת ומורחבת עד 130 מילים סהכ.`
      : `${basePersonality} ענה בציטוט קצר ותמציתי עד 45 מילים בלבד.`;

    const lowerTranscription = transcribedText.toLowerCase();
    const SEARCH_KEYWORDS = ["חפש", "חדשות", "עדכון", "היום", "מי", "מה", "איפה", "מתי", "כמה", "איך", "תוצאות", "מזג אוויר", "תוצאה", "מחיר"];
    const needsSearch = SEARCH_KEYWORDS.some(word => lowerTranscription.includes(word));

    // --- עדיפות 1: Gemini Call ---
    if (geminiKeys.length > 0) {
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

    // --- עדיפות 2: OpenAI Call (במידה ו-Gemini נכשל) ---
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

    // --- עדיפות 3: OpenRouter Call (עם הנתב החינמי האוטומטי) ---
    if (!finalAnswerText && openRouterKeys.length > 0) {
      console.log(`🤖 [עדיפות 3] מנסה OpenRouter עם הנתב החינמי (${openRouterKeys.length} מפתחות)...`);
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
          console.log("📡 שולח בקשה ל-OpenRouter (openrouter/auto)...");
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
      console.warn("⚠️ כל המודלים (Gemini, OpenAI ו-OpenRouter) כשלו או הגיעו למכסה.");
      finalAnswerText = "הגעת למכסה היומית אנא נסה שוב מאוחר יותר";
      usedModelName = "system-fallback";
    }

    const normalizedAnswer = normalizeText(finalAnswerText);
    if (normalizedAnswer.includes(BLOCKED_RESPONSE_MARKER)) {
      console.warn(`⚠️ תשובת המודל הכילה חסימה עבור משתמש ${userPhone}`);
      userSession.blockedAttempts += 1;
      if (userSession.blockedAttempts >= 3) {
        await blockUserPermanently(userPhone);
        return sendYemotTtsResponse(res, BANNED_USER_RESPONSE);
      }
      conversationHistory.set(userPhone, userSession);
      return sendYemotTtsResponse(res, getWarningMessage(userSession.blockedAttempts));
    }

    logConversationToSupabase(userPhone, transcribedText, finalAnswerText, usedModelName);

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

loadBannedPhones().then(() => {
  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});
