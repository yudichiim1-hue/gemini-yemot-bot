const express = require("express");
const axios = "axios" in globalThis ? globalThis.axios : require("axios");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

const processedCalls = new Map();
const conversationHistory = new Map();

const RESET_TRIGGERS = [
  "תתחיל מחדש",
  "תתחילי מחדש",
  "אפס שיחה",
  "איפוס שיחה",
  "שיחה חדשה",
  "התחל מחדש",
  "תמחק היסטוריה",
  "ניקוי היסטוריה"
];

app.get("/ping", (req, res) => {
  res.status(200).send("PONG");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date() });
});

const callGeminiWithRetry = async (model, payload, geminiApiKey, maxRetries = 2) => {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Gemini] שולח בקשה למודל ${model} (ניסיון ${attempt}/${maxRetries})...`);
      const response = await axios.post(geminiUrl, payload, { 
        headers: { "Content-Type": "application/json" }, 
        timeout: 9000 
      });
      console.log(`[Gemini] התקבלה תשובה בהצלחה ממודל ${model}`);
      return response;
    } catch (err) {
      const status = err.response?.status;
      console.error(`[Gemini Error] שגיאה במודל ${model} (סטטוס: ${status || 'unknown'}):`, err.message);
      if (status === 429 && attempt < maxRetries) {
        const delay = 1500 * attempt; 
        console.log(`[Gemini] עומס (429), ממתין ${delay}ms ומנסה שוב...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
};

const handleAudioRequest = async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const callId = params.ApiCallId || params.ApiYFCallId;
    const userPhone = params.ApiPhone || params.phone || "default_user";
    const secondaryFolder = params.SHL || "1";
    const primaryFolder = params.SHM || "2";

    // --- לוג מפורט מאוד של פרטי ההתקשרות ומערכת ימות המשיח ---
    console.log("\n==================================================");
    console.log("📞 [ימות המשיח] התקבלה פנייה חדשה מהמערכת!");
    console.log("--------------------------------------------------");
    console.log(`📌 מספר טלפון מתקשר (ApiPhone): ${params.ApiPhone || params.phone || 'לא זוהה'}`);
    console.log(`🆔 מזהה שיחה ייחודי (CallId): ${callId || 'לא זוהה'}`);
    console.log(`📂 תיקייה ראשית (SHM): ${primaryFolder}`);
    console.log(`📂 תיקייה משנית/קודמת (SHL): ${secondaryFolder}`);
    console.log(`🌐 כתובת קובץ שהועברה (path/file): ${params.path || params.file || 'לא הועבר, יחפש לפי ברירת מחדל'}`);
    console.log("📋 כל הפרמטרים שהתקבלו מהמערכת:", JSON.stringify(params, null, 2));
    console.log("==================================================\n");

    if (callId && processedCalls.has(callId)) {
      console.log(`[Duplicate Call] שיחה כפולה זוהתה עבור Call ID: ${callId}. מדלג ומחזיר ניתוב לתיקייה /1.`);
      processedCalls.delete(callId);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`go_to_folder=/1`);
    }

    const token = params.token || params.TOKEN || "WU1BUElL.apik_H8E4CZtg_8iQ0kMQLYzFrw.X5JSBHi5D-dw_BWfX_3vIrgoR9jYSzUdiITDwdsIHCM";
    const groqApiKey = (process.env.GROQ_API_KEY || "").trim();
    const openRouterApiKey = (process.env.OPENROUTER_API_KEY || "").trim();
    
    const geminiKeys = [
      (process.env.GEMINI_API_KEY || "").trim(),
      (process.env.GEMINI_API_KEY_1 || "").trim()
    ].filter(key => key.length > 0);

    let audioBuffer = null;
    const possiblePaths = [];

    if (params.path) possiblePaths.push(params.path);
    if (params.file) possiblePaths.push(params.file);
    possiblePaths.push(`ivr2:/${secondaryFolder}/last.wav`);
    possiblePaths.push(`ivr2:/${primaryFolder}/last.wav`);

    console.log("[Audio Download] מנסה להוריד את קובץ הקול מהנתיבים האפשריים:", possiblePaths);

    for (let rawPath of possiblePaths) {
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;

      try {
        console.log(`[Audio Download] מנסה להוריד נתיב: ${cleanPath}`);
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 6000 });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          console.log(`[Audio Download] הצלחה! הורד בהجלחה קובץ בגודל ${audioBuffer.length} בתים מנתיב: ${cleanPath}`);
          break;
        }
      } catch (err) {
        console.log(`[Audio Download Fail] נכשל בהורדת הנתיב ${cleanPath}:`, err.message);
      }
    }

    if (!audioBuffer) {
      console.log("[Audio Error] לא נמצאה הקלטה תקינה באף אחד מהנתיבים!");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-לא נמצאה הקלטה תקינה אנא הקלט שוב&go_to_folder=/1`);
    }

    let transcribedText = "";

    if (groqApiKey) {
      try {
        console.log("[Groq Whisper] שולח קובץ שמע לתמלול ב-Groq...");
        const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
        let formDataHeader = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n`;
        formDataHeader += `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nhe\r\n`;
        formDataHeader += `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nתמלל בעברית תקנית בלבד, כולל סלנג וביטויים ישראליים. אל תמציא מילים.\r\n`;
        formDataHeader += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
        const formDataFooter = `\r\n--${boundary}--\r\n`;

        const fullBuffer = Buffer.concat([
          Buffer.from(formDataHeader, "utf-8"),
          audioBuffer,
          Buffer.from(formDataFooter, "utf-8")
        ]);

        const transcriptionResponse = await axios.post(
          "https://api.groq.com/openai/v1/audio/transcriptions",
          fullBuffer,
          {
            headers: {
              "Authorization": `Bearer ${groqApiKey}`,
              "Content-Type": `multipart/form-data; boundary=${boundary}`
            },
            timeout: 10000
          }
        );

        transcribedText = (transcriptionResponse.data?.text || "").trim();
        console.log(`[Groq Whisper Success] תוצאת תמלול: "${transcribedText}"`);
      } catch (err) {
        console.error("[Groq Whisper Error] שגיאה בתמלול Groq:", err.message);
      }
    }

    const lowerTranscription = transcribedText.toLowerCase();
    const isResetRequested = RESET_TRIGGERS.some(trigger => lowerTranscription.includes(trigger));

    if (isResetRequested) {
      console.log(`[Reset] זוהתה בקשת איפוס שיחה מהמשתמש (${userPhone}). מאפס היסטוריה.`);
      const existingSession = conversationHistory.get(userPhone);
      if (existingSession?.timer) clearTimeout(existingSession.timer);
      conversationHistory.delete(userPhone);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-השיחה אופסה בהצלחה במה אוכל לעזור&go_to_folder=/1`);
    }

    let userSession = conversationHistory.get(userPhone) || { history: [], timer: null };
    if (userSession.timer) clearTimeout(userSession.timer);
    userSession.timer = setTimeout(() => {
      console.log(`[Session Timeout] עברו 10 דקות ללא פעילות, מוחק היסטוריה למשתמש ${userPhone}`);
      conversationHistory.delete(userPhone);
    }, 10 * 60 * 1000);

    let finalAnswerText = "";
    
    const systemInstruction = "אתה עוזר קולי חכם בשיחת טלפון. ענה בצורה טבעית, מדויקת ומפורטת במידת הצורך. לעולם אל תאמר שאין לך גישה לאינטרנט או שאתה מודל שפה. מותר ואף רצוי להשתמש במספרים, נתונים עובדתיים ואותיות או מילים באנגלית כאשר השאלה דורשת זאת. כשאתה נותן קודים או מילים באנגלית שיש להקריא אות אחר אות הפד והפרד כל אות באנגלית ברווח ברור (למשל A I W P R T O N). הימנע מסימני פיסוק או פסיקים והקפד על תשובה ישירה.";

    const isGroqTranscriptionWeak = !transcribedText || transcribedText.split(" ").length < 2;
    
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
      console.log("🔍 [Search Triggered] התנאים מתאימים - מפעיל חיפוש חי באינטרנט (Google Search Tool).");
    }

    if (geminiKeys.length > 0) {
      const geminiModels = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

      const geminiContents = [
        { role: "user", parts: [{ text: systemInstruction }] },
        { role: "model", parts: [{ text: "מבין אענה באופן מדויק ובמידת הצורך אשתמש בחיפוש." }] }
      ];

      userSession.history.forEach((msg) => {
        geminiContents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }]
        });
      });

      if (isGroqTranscriptionWeak) {
        console.log("[Gemini Fallback] תמלול Groq חלש או ריק, שולח את קובץ הקול הישירות ל-Gemini.");
        geminiContents.push({
          role: "user",
          parts: [
            { text: "האזן להקלטה הבאה והשב עליה ישירות:" },
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

      keyLoop:
      for (let i = 0; i < geminiKeys.length; i++) {
        const apiKey = geminiKeys[i];
        for (const model of geminiModels) {
          try {
            const response = await callGeminiWithRetry(model, payload, apiKey);
            if (response?.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
              finalAnswerText = response.data.candidates[0].content.parts[0].text;
              if (isGroqTranscriptionWeak) transcribedText = "[שמע שפוענח ישירות ע״י Gemini]";
              console.log(`[Gemini Success] התקבלה תשובה מפתח ${i+1} וממודל ${model}`);
              break keyLoop;
            }
          } catch (err) {}
        }
      }
    }

    if (!finalAnswerText && openRouterApiKey && transcribedText.length > 0 && !isGroqTranscriptionWeak) {
      try {
        console.log("[OpenRouter] מנסה לקבל תשובה מ-OpenRouter...");
        const messagesPayload = [
          { role: "system", content: systemInstruction },
          ...userSession.history,
          { role: "user", content: transcribedText }
        ];

        const openRouterCompletion = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          { model: "openrouter/free", messages: messagesPayload, temperature: 0.3 },
          { headers: { "Authorization": `Bearer ${openRouterApiKey}`, "Content-Type": "application/json" }, timeout: 5000 }
        );

        finalAnswerText = openRouterCompletion.data?.choices?.[0]?.message?.content || "";
        console.log("[OpenRouter Success] התקבלה תשובה מ-OpenRouter.");
      } catch (err) {
        console.error("[OpenRouter Error] שגיאה ב-OpenRouter:", err.message);
      }
    }

    if (!finalAnswerText) {
      finalAnswerText = "סליחה לא הבנתי את דבריך אנא נסה שנית";
    }

    const cleanText = finalAnswerText
      .replace(/[,.?!:;'"״׳`_\-*~#–—&?=<>/()\\[\]{}]/g, " ") 
      .replace(/\s+/g, " ")                                 
      .trim();

    console.log(`💬 [Final Answer] תשובה סופית נקייה להקראה למשתמש: "${cleanText}"`);

    if (transcribedText) {
      userSession.history.push({ role: "user", content: transcribedText });
      userSession.history.push({ role: "assistant", content: cleanText });
      if (userSession.history.length > 6) userSession.history = userSession.history.slice(-6);
      conversationHistory.set(userPhone, userSession);
      console.log(`[Memory] היסטוריית השיחה עודכנה עבור משתמש ${userPhone} (סך הכל הודעות בזיכרון: ${userSession.history.length})`);
    }

    if (callId) {
      processedCalls.set(callId, true);
      setTimeout(() => processedCalls.delete(callId), 5000);
    }

    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-${cleanText}&go_to_folder=/1`);

  } catch (error) {
    console.error("❌ === שגיאה כוללת במערכת ===", error.message, error.stack);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-חלה שגיאה אנא נסה שנית&go_to_folder=/1`);
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
