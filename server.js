const express = require("express");
const axios = "axios" in globalThis ? globalThis.axios : require("axios");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

const processedCalls = new Map();
const conversationHistory = new Map();

// סט יעודי לשמירת מספרי טלפון חסומים בלבד (חיסכון בזיכרון)
const bannedPhones = new Set();

// טעינת מספרים חסומים מראש ממשתני הסביבה (אם הוגדרו)
if (process.env.INITIAL_BANNED_PHONES) {
  try {
    const parsedBanned = JSON.parse(process.env.INITIAL_BANNED_PHONES);
    if (Array.isArray(parsedBanned)) {
      parsedBanned.forEach((phone) => bannedPhones.add(String(phone).trim()));
      console.log(`🔒 נטענו ${bannedPhones.size} מספרים חסומים ממשתני הסביבה.`);
    }
  } catch (err) {
    console.error("❌ שגיאה בפענוח INITIAL_BANNED_PHONES ממשתני הסביבה:", err.message);
  }
}

// משתנה לניהול הפוגה עבור Gemini
let geminiCooldownUntil = 0;

// ניקוי זיכרון תקופתי (פעם בשעה) להסטוריית שיחות פעילות בלבד
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
    oldestKeys.forEach((key) => conversationHistory.delete(key));
  }
}, 60 * 60 * 1000);

// פונקציה לנרמול טקסט (הסרת אותיות סופיות, ניקוד ורווחים)
const normalizeText = (text) => {
  if (!text) return "";
  return text
    .replace(/[\u0591-\u05C7]/g, "") // הסרת ניקוד
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
  "תתחיל מחדש",
  "תתחילי מחדש",
  "אפס שיחה",
  "איפוס שיחה",
  "שיחה חדשה",
  "התחל מחדש",
  "תמחק היסטוריה",
  "ניקוי היסטוריה"
].map(normalizeText);

const DEEP_DETAILS_TRIGGERS = [
  "תתעמק",
  "תתעמקי",
  "תרחיב",
  "תרחיבי",
  "בהרחבה",
  "תפרט",
  "תפרטי",
  "עוד מידע",
  "פירוט",
  "מידע מפורט"
].map(normalizeText);

const BLOCKED_KEYWORDS = [
  "סקס",
  "פורנו",
  "עירום",
  "זונה",
  "שרמוטה",
  "אונס",
  "זין",
  "כוס"
].map(normalizeText);

// פונקציה ליצירת הודעת אזהרה דינמית ללא סימני פיסוק
const getWarningMessage = (attempts) => {
  if (attempts === 1) {
    return "המפתחים שלי הגדירו שאסור לי לענות על זה זוהי אזהרה ראשונה מתוך שלוש במידה ותגיע לשלוש אזהרות תחסם מהמערכת";
  }
  if (attempts === 2) {
    return "המפתחים שלי הגדירו שאסור לי לענות על זה זוהי אזהרה שנייה מתוך שלוש באזהרה הבאה תחסם מהמערכת";
  }
  return "חשבונך נחסם לשימוש במערכת עקב חריגה מוגזמת מכללי השימוש";
};

const BANNED_USER_RESPONSE = "חשבונך נחסם לשימוש במערכת עקב חריגה מוגזמת מכללי השימוש";
const BLOCKED_RESPONSE_MARKER = "המפתחים שלי הגדירו לי שאסור לי לענות על זה";

// middleware לאימות מפתח הניהול (ADMIN_KEY)
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

// נתיבי ניהול חסומים (Admin Endpoints)
app.get("/admin/banned", authenticateAdmin, (req, res) => {
  res.status(200).json({
    totalBanned: bannedPhones.size,
    bannedPhones: Array.from(bannedPhones)
  });
});

app.get("/admin/add-ban", authenticateAdmin, (req, res) => {
  const phone = (req.query.phone || "").trim();
  if (!phone) {
    return res.status(400).json({ error: "Missing 'phone' parameter" });
  }

  bannedPhones.add(phone);

  // ניקוי סשן פעיל אם קיים
  if (conversationHistory.has(phone)) {
    const session = conversationHistory.get(phone);
    if (session.timer) clearTimeout(session.timer);
    conversationHistory.delete(phone);
  }

  res.status(200).json({
    message: `Phone number ${phone} added to banned list successfully`,
    totalBanned: bannedPhones.size
  });
});

app.get("/admin/remove-ban", authenticateAdmin, (req, res) => {
  const phone = (req.query.phone || "").trim();
  if (!phone) {
    return res.status(400).json({ error: "Missing 'phone' parameter" });
  }

  const existed = bannedPhones.delete(phone);

  res.status(200).json({
    message: existed
      ? `Phone number ${phone} removed from banned list successfully`
      : `Phone number ${phone} was not in the banned list`,
    totalBanned: bannedPhones.size
  });
});

app.get("/ping", (req, res) => {
  res.status(200).send("PONG");
});

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
  const response = await axios.post(geminiUrl, payload, { 
    headers: { "Content-Type": "application/json" }, 
    timeout: 12000 
  });
  return response;
};

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const callId = params.ApiCallId || params.ApiYFCallId;
    const userPhone = params.ApiPhone || params.phone || "default_user";
    const systemDid = params.ApiRealDID || params.ApiDID || "לא ידוע";
    const secondaryFolder = params.SHL || "1";
    const primaryFolder = params.SHM || "2";

    console.log("\n==================================================");
    console.log("📞 [ימות המשיח] התקבלה פנייה חדשה למערכת!");
    console.log(`🏢 מספר מערכת (DID): ${systemDid}`);
    console.log(`📌 מספר טלפון מתקשר: ${userPhone}`);
    console.log("==================================================\n");

    if (callId && processedCalls.has(callId)) {
      console.log(`⚠️ שיחה כפולה זוהתה (CallID: ${callId}), מתעלם ומחזיר לתיקייה.`);
      processedCalls.delete(callId);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`go_to_folder=/1`);
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

    const token = params.token || params.TOKEN || "WU1BUElL.apik_H8E4CZtg_8iQ0kMQLYzFrw.X5JSBHi5D-dw_BWfX_3vIrgoR9jYSzUdiITDwdsIHCM";
    const deepgramApiKey = (process.env.DEEPGRAM_API_KEY || "").trim();
    
    const geminiKeys = [
      (process.env.GEMINI_API_KEY || "").trim(),
      (process.env.GEMINI_API_KEY_1 || "").trim(),
      (process.env.GEMINI_API_KEY_2 || "").trim()
    ].filter(key => key.length > 0);

    const openRouterKeys = [
      (process.env.OPENROUTER_API_KEY || "").trim(),
      (process.env.OPENROUTER_API_KEY_1 || "").trim()
    ].filter(key => key.length > 0);

    let audioBuffer = null;
    const possiblePaths = [];

    if (params.path) possiblePaths.push(params.path);
    if (params.file) possiblePaths.push(params.file);
    possiblePaths.push(`ivr2:/${secondaryFolder}/last.wav`);
    possiblePaths.push(`ivr2:/${primaryFolder}/last.wav`);

    console.log("📁 מנסה להוריד את קובץ השמע מהנתיבים האפשריים...");
    for (let rawPath of possiblePaths) {
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;

      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 8000 });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          console.log(`✅ ההקלטה הורידה בהצלחה מנתיב: ${cleanPath} (גודל: ${audioBuffer.length} באית)`);
          break;
        }
      } catch (err) {
        console.log(`❌ נכשל הורדה מנתיב: ${cleanPath}`);
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
        console.log("🎙️ שולח את השמע לתמלול ב-Deepgram (Nova-3)...");
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
        console.error("❌ שגיאה בתמלול Deepgram:", err.response?.data || err.message);
      }
    } else {
      console.log("⚠️ לא הוגדר מפתח DEEPGRAM_API_KEY. ממשיך ללא תמלול מוקדם.");
    }

    const normalizedTranscription = normalizeText(transcribedText);

    const isBlocked = BLOCKED_KEYWORDS.some(keyword => normalizedTranscription.includes(keyword));
    if (isBlocked) {
      userSession.blockedAttempts += 1;
      console.log(`🛑 זוהה תוכן לא ראוי בתמלול! אזהרה ${userSession.blockedAttempts}/3 למספר ${userPhone}`);

      if (userSession.blockedAttempts >= 3) {
        console.log(`🔒 המספר ${userPhone} הגיע ל-3 אזהרות! חוסם לצמיתות ומנקה סשן.`);
        bannedPhones.add(userPhone);
        if (userSession.timer) clearTimeout(userSession.timer);
        conversationHistory.delete(userPhone);

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
    
    const basePersonality = "אתה עוזר קולי יעיל. כאשר שואלים אותך מה חדש חדשות או שאלות עובדתיות ענה באופן עובדתי ואינפורמטיבי. אך רק כאשר שואלים אותך מפורשות על דעתך עמדתך או נושאים פוליטיים ומדיניים ענה מנקודת מבט ימנית ציונית גאה המביעה תמיכה מלאה במדינת ישראל בממשלה בראש הממשלה בנימין נתניהו ובצהל. כלל ברזל חשוב: אם המשתמש שואל שאלה בעלת אופי מיני בוטה שוביניסטי או תוכן לא ראוי ענה אך ורק במילים המפתחים שלי הגדירו לי שאסור לי לענות על זה. לעולם אל תשתמש בסימני פיסוק. אל תאמר שאין לך גישה לאינטרנט או שאתה מודל שפה. אם נדרשת מילה באנגלית הפרד את האותיות ברווחים.";
    
    const systemInstruction = isDeepRequested
      ? `${basePersonality} המשתמש ביקש שתתעמק ותפרט. ענה בצורה מפורטת ומורחבת עד 120 מילים סהכ.`
      : `${basePersonality} ענה בציטוט קצר ותמציתי עד 35 מילים בלבד.`;

    if (isDeepRequested) {
      console.log("📖 זוהתה בקשה להעמקה/פירוט - מרחיב את תשובת המודל.");
    }

    const isTranscriptionWeak = !transcribedText || transcribedText.split(" ").length < 2;
    if (isTranscriptionWeak) {
      console.log("⚠️ התמלול מ-Deepgram חלש או ריק. הקובץ יועבר ישירות לפיענוח של Gemini.");
    }
    
    const lowerTranscription = transcribedText.toLowerCase();
    const needsSearch = 
      lowerTranscription.startsWith("חפש") || 
      lowerTranscription.startsWith("חפשי") || 
      lowerTranscription.includes(" חפש ") || 
      lowerTranscription.includes(" חפשי ") ||
      lowerTranscription.includes("מה חדש") ||
      lowerTranscription.includes("חדשות") ||
      lowerTranscription.includes("עדכון") ||
      lowerTranscription.includes("עדכונים") ||
      lowerTranscription.includes("היום");

    if (needsSearch) {
      console.log("🔍 זוהתה בקשת חיפוש באינטרנט.");
    }

    const isGeminiOnCooldown = Date.now() < geminiCooldownUntil;

    if (isGeminiOnCooldown) {
      const remainingMinutes = Math.ceil((geminiCooldownUntil - Date.now()) / (1000 * 60));
      console.log(`⏳ Gemini נמצא כרגע בהפוגה (נותרו עוד ${remainingMinutes} דקות). מדלג ישירות ל-OpenRouter.`);
    }

    // --- שלב 1: Gemini Direct (כולל חיפוש גוגל מובנה) ---
    if (!isGeminiOnCooldown && geminiKeys.length > 0 && !finalAnswerText) {
      const geminiModels = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];

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
      
      if (needsSearch) {
        payload.tools = [{ googleSearch: {} }];
      }

      for (let k = 0; k < geminiKeys.length; k++) {
        if (finalAnswerText) break;
        const apiKey = geminiKeys[k];
        for (const model of geminiModels) {
          try {
            console.log(`🤖 מנסה Gemini | מפתח ${k + 1} | מודל ${model}...`);
            const response = await callGeminiSimple(model, payload, apiKey);
            if (response?.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
              finalAnswerText = response.data.candidates[0].content.parts[0].text;
              if (isTranscriptionWeak) transcribedText = "[שמע שפוענח ישירות ע״י Gemini]";
              console.log(`✅ [Gemini Success] התקבלה תשובה ממפתח ${k + 1} ומודל ${model}`);
              break;
            }
          } catch (err) {
            const statusCode = err.response?.status;
            console.log(`❌ [Gemini Error] מפתח ${k + 1} מודל ${model} נכשל (קוד: ${statusCode || "ללא"}): ${err.message}`);

            if (statusCode === 429) {
              geminiCooldownUntil = Date.now() + 10 * 60 * 1000;
              console.log("⛔ חריגת מכסה 429 זוהתה ב-Gemini! מפעיל הפוגה של 10 דקות.");
            } else if ([500, 502, 503, 504].includes(statusCode)) {
              geminiCooldownUntil = Date.now() + 2 * 60 * 1000;
              console.log("⚠️ שגיאת שרת פנימית ב-Gemini! מפעיל הפוגה קצרה של 2 דקות.");
            }
          }
        }
      }
    }

    // --- שלב 2: OpenRouter (מקסימום 3 מודלים במערך לפי מגבלות ה-API) ---
    if (!finalAnswerText && openRouterKeys.length > 0 && transcribedText.length > 0) {
      const messagesPayload = [
        { role: "system", content: systemInstruction },
        ...userSession.history,
        { role: "user", content: transcribedText }
      ];

      // OpenRouter מגבילה את המערך ל-3 פריטים לכל היותר
      const preferredModels = [
        "openrouter/auto",                            
        "google/gemini-2.0-flash-lite-001:online",   
        "meta-llama/llama-3.3-70b-instruct"
      ];

      for (let i = 0; i < openRouterKeys.length; i++) {
        if (finalAnswerText) break;
        const orKey = openRouterKeys[i].trim();

        try {
          console.log(`🌐 מנסה OpenRouter עם מערך מודלים | מפתח ${i + 1}...`);
          
          const payload = { 
            models: preferredModels, 
            messages: messagesPayload, 
            temperature: 0.3 
          };

          if (needsSearch) {
            payload.plugins = [{ id: "web" }];
          }

          const openRouterCompletion = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            payload,
            { 
              headers: { 
                "Authorization": `Bearer ${orKey}`, 
                "Content-Type": "application/json",
                "HTTP-Referer": "https://yemot-telephony-ai.com",
                "X-Title": "Yemot Telephony AI"
              }, 
              timeout: 12000 
            }
          );

          finalAnswerText = openRouterCompletion.data?.choices?.[0]?.message?.content || "";
          const usedModel = openRouterCompletion.data?.model || "מנותב אוטומטית";

          if (finalAnswerText) {
            console.log(`✅ [OpenRouter Success] התקבלה תשובה מ-OpenRouter (מודל שנבחר: ${usedModel})`);
            break;
          }
        } catch (err) {
          const statusCode = err.response?.status;
          console.log(`❌ [OpenRouter Error] מפתח ${i + 1} נכשל (קוד ${statusCode || "ללא"}): ${err.response?.data?.error?.message || err.message}`);
        }
      }
    }

    if (!finalAnswerText) {
      console.log("❌ כל המפתחות (Gemini ו-OpenRouter) נכשלו או הגיעו למכסה!");
      finalAnswerText = "הגעת למכסה היומית אנא נסה שוב מאוחר יותר";
    }

    if (finalAnswerText.includes(BLOCKED_RESPONSE_MARKER)) {
      userSession.blockedAttempts += 1;
      console.log(`🛑 המודל החזיר תשובת חסימה! אזהרה ${userSession.blockedAttempts}/3 למספר ${userPhone}`);
      
      if (userSession.blockedAttempts >= 3) {
        console.log(`🔒 המספר ${userPhone} הגיע ל-3 אזהרות! חוסם לצמיתות ומנקה סשן.`);
        bannedPhones.add(userPhone);
        if (userSession.timer) clearTimeout(userSession.timer);
        conversationHistory.delete(userPhone);

        res.set("Content-Type", "text/plain; charset=utf-8");
        return res.send(`id_list_message=t-${BANNED_USER_RESPONSE}&go_to_folder=/1`);
      }

      finalAnswerText = getWarningMessage(userSession.blockedAttempts);
    }

    const cleanText = finalAnswerText
      .replace(/[,.?!:;'"״׳`_\-*~#–—&?=<>/()\\[\]{}]/g, " ") 
      .replace(/\s+/g, " ")                                 
      .trim();

    console.log(`💬 [Final Answer Ready]: "${cleanText}"`);

    if (transcribedText && !transcribedText.startsWith("[שמע")) {
      userSession.history.push({ role: "user", content: transcribedText });
      userSession.history.push({ role: "assistant", content: cleanText });
      if (userSession.history.length > 6) userSession.history = userSession.history.slice(-6);
      conversationHistory.set(userPhone, userSession);
    }

    if (callId) {
      processedCalls.set(callId, true);
      setTimeout(() => processedCalls.delete(callId), 5000);
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
