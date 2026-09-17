const express = require("express");
const axios = "axios" in globalThis ? globalThis.axios : require("axios");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

const processedCalls = new Map();
const conversationHistory = new Map();

// משתנה לניהול הפוגה עבור Gemini
let geminiCooldownUntil = 0;

// [שיפור 1]: ניקוי זיכרון תקופתי (פעם בשעה) ומניעת זליגת זיכרון
setInterval(() => {
  const now = Date.now();
  console.log("🧹 מפעיל ניקוי זיכרון תקופתי להסטוריית השיחות...");
  for (const [phone, session] of conversationHistory.entries()) {
    if (session.lastActive && now - session.lastActive > 10 * 60 * 1000) {
      if (session.timer) clearTimeout(session.timer);
      conversationHistory.delete(phone);
    }
  }
  // אם עדיין יש יתר על המידה, מגבילים ל-500 שיחות אחרונות
  if (conversationHistory.size > 500) {
    const oldestKeys = Array.from(conversationHistory.keys()).slice(0, conversationHistory.size - 500);
    oldestKeys.forEach((key) => conversationHistory.delete(key));
  }
}, 60 * 60 * 1000);

// [שיפור 4]: פונקציה לנרמול טקסט (הסרת אותיות סופיות, ניקוד ורווחים)
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

const BLOCKED_RESPONSE = "המפתחים שלי הגדירו לי שאסור לי לענות על זה";

app.get("/ping", (req, res) => {
  res.status(200).send("PONG");
});

app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "ok", 
    geminiOnCooldown: Date.now() < geminiCooldownUntil,
    activeSessions: conversationHistory.size,
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

    // [שיפור 4]: בדיקה מול טקסט מנורמל
    const normalizedTranscription = normalizeText(transcribedText);

    const isBlocked = BLOCKED_KEYWORDS.some(keyword => normalizedTranscription.includes(keyword));
    if (isBlocked) {
      console.log("🛑 זוהה תוכן לא ראוי בתמלול! מחזיר חסימה מיידית ללא פנייה ל-AI.");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-${BLOCKED_RESPONSE}&go_to_folder=/1`);
    }

    const isResetRequested = RESET_TRIGGERS.some(trigger => normalizedTranscription.includes(trigger));

    if (isResetRequested) {
      console.log("🔄 זוהתה בקשת איפוס שיחה!");
      const existingSession = conversationHistory.get(userPhone);
      if (existingSession?.timer) clearTimeout(existingSession.timer);
      conversationHistory.delete(userPhone);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-השיחה אופסה בהצלחה במה אוכל לעזור&go_to_folder=/1`);
    }

    const isDeepRequested = DEEP_DETAILS_TRIGGERS.some(trigger => normalizedTranscription.includes(trigger));

    let userSession = conversationHistory.get(userPhone) || { history: [], timer: null, lastActive: Date.now() };
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
      console.log("🔍 זוהתה בקשת חיפוש באינטרנט - מפעיל Google Search Grounding.");
    }

    const isGeminiOnCooldown = Date.now() < geminiCooldownUntil;

    if (isGeminiOnCooldown) {
      const remainingMinutes = Math.ceil((geminiCooldownUntil - Date.now()) / (1000 * 60));
      console.log(`⏳ Gemini נמצא כרגע בהפוגה (נותרו עוד ${remainingMinutes} דקות). מדלג ישירות ל-OpenRouter.`);
    }

    // --- שלב 1: מעבר על מפתחות Gemini (רק אם לא בהפוגה) ---
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

            // [שיפור 3]: הטיפול בשגיאות שרת והפוגות מותאמות
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

    // --- שלב 2: מעבר על מפתחות OpenRouter ---
    if (!finalAnswerText && openRouterKeys.length > 0 && transcribedText.length > 0) {
      const messagesPayload = [
        { role: "system", content: systemInstruction },
        ...userSession.history,
        { role: "user", content: transcribedText }
      ];

      for (let i = 0; i < openRouterKeys.length; i++) {
        if (finalAnswerText) break;
        const orKey = openRouterKeys[i];
        try {
          console.log(`🌐 מנסה OpenRouter | מפתח ${i + 1}...`);
          const openRouterCompletion = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            { model: "openrouter/free", messages: messagesPayload, temperature: 0.3 },
            { headers: { "Authorization": `Bearer ${orKey}`, "Content-Type": "application/json" }, timeout: 8000 }
          );

          finalAnswerText = openRouterCompletion.data?.choices?.[0]?.message?.content || "";
          if (finalAnswerText) {
            console.log(`✅ [OpenRouter Success] התקבלה תשובה ממפתח ${i + 1}`);
            break;
          }
        } catch (err) {
          console.log(`❌ [OpenRouter 429/Error] מפתח ${i + 1} נכשל: ${err.message}`);
        }
      }
    }

    if (!finalAnswerText) {
      console.log("❌ כל המפתחות (Gemini ו-OpenRouter) נכשלו או הגיעו למכסה!");
      finalAnswerText = "הגעת למכסה היומית אנא נסה שוב מאוחר יותר";
    }

    // הסרת כל סימני הפיסוק באופן מוחלט
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
