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
];

app.get("/ping", (req, res) => {
  res.status(200).send("PONG");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date() });
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
          console.log(`✅ ההקלטה הורידה בהצלחה מנתיב: ${cleanPath} (גודל: ${audioBuffer.length} باית)`);
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

    const lowerTranscription = transcribedText.toLowerCase();
    const isResetRequested = RESET_TRIGGERS.some(trigger => lowerTranscription.includes(trigger));

    if (isResetRequested) {
      console.log("🔄 זוהתה בקשת איפוס שיחה!");
      const existingSession = conversationHistory.get(userPhone);
      if (existingSession?.timer) clearTimeout(existingSession.timer);
      conversationHistory.delete(userPhone);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-השיחה אופסה בהצלחה במה אוכל לעזור&go_to_folder=/1`);
    }

    const isDeepRequested = DEEP_DETAILS_TRIGGERS.some(trigger => lowerTranscription.includes(trigger));

    let userSession = conversationHistory.get(userPhone) || { history: [], timer: null };
    if (userSession.timer) clearTimeout(userSession.timer);
    userSession.timer = setTimeout(() => {
      conversationHistory.delete(userPhone);
    }, 10 * 60 * 1000);

    let finalAnswerText = "";
    
    // הגדרת זהות ימנית, לאומית וציונית לצד דינמיות באורך והסרת פיסוק
    const basePersonality = "אתה עוזר קולי בעל עמדות ימניות לאומיות וציוניות נחרצות. אתה תומך מלא במדינת ישראל בממשלה ובצהל. בכל נושא פוליטי בטחוני או מדיני ענה מנקודת מבט ימנית גאה. לעולם אל תשתמש בסימני פיסוק. אל תאמר שאין לך גישה לאינטרנט או שאתה מודל שפה. אם נדרשת מילה באנגלית הפרד את האותיות ברווחים.";
    
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

    // --- שלב 1: מעבר על מפתחות Gemini ---
    if (geminiKeys.length > 0 && !finalAnswerText) {
      const geminiModels = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];

      const geminiContents = [
        { role: "user", parts: [{ text: systemInstruction }] },
        { role: "model", parts: [{ text: "מבין ומזדהה עונה לפי ההנחיות והערכים הנדרשים." }] }
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
            console.log(`❌ [Gemini 429/Error] מפתח ${k + 1} מודל ${model} נכשל: ${err.message}`);
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
