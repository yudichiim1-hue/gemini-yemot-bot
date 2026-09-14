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
      const response = await axios.post(geminiUrl, payload, { 
        headers: { "Content-Type": "application/json" }, 
        timeout: 7000 
      });
      return response;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < maxRetries) {
        const delay = 1500 * attempt; 
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

    console.log("\n==========================================");
    console.log("--- קריאה חדשה התקבלה ---");
    console.log("Call ID:", callId);
    console.log("Phone:", userPhone);

    if (callId && processedCalls.has(callId)) {
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

    for (let rawPath of possiblePaths) {
      let cleanPath = rawPath.startsWith("ivr2:") ? rawPath : (rawPath.startsWith("/") ? `ivr2:${rawPath}` : `ivr2:/${rawPath}`);
      const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(cleanPath)}`;

      try {
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 6000 });
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

    // תמלול ראשוני ב-Groq Whisper
    if (groqApiKey) {
      try {
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
      } catch (err) {
        console.error("[Groq Error]:", err.message);
      }
    }

    // בדיקת איפוס שיחה
    const lowerTranscription = transcribedText.toLowerCase();
    const isResetRequested = RESET_TRIGGERS.some(trigger => lowerTranscription.includes(trigger));

    if (isResetRequested) {
      const existingSession = conversationHistory.get(userPhone);
      if (existingSession?.timer) clearTimeout(existingSession.timer);
      conversationHistory.delete(userPhone);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send(`id_list_message=t-השיחה אופסה בהצלחה במה אוכל לעזור&go_to_folder=/1`);
    }

    let userSession = conversationHistory.get(userPhone) || { history: [], timer: null };
    if (userSession.timer) clearTimeout(userSession.timer);
    userSession.timer = setTimeout(() => conversationHistory.delete(userPhone), 10 * 60 * 1000);

    let finalAnswerText = "";
    const systemInstruction = "אתה עוזר קולי חכם בטלפון. ענה בעברית פשוטה בלבד, ברורה וישירה. ללא סימני פיסוק, ללא מספרים, ללא אנגלית. עד 2 משפטים רציפים קצרים.";

    const isGroqTranscriptionWeak = !transcribedText || transcribedText.split(" ").length < 2;

    // --- עדיפות 1: Gemini (אם התמלול של גרוק חלש, נותנים לגימיני לשמוע קול, אחרת שולחים טקסט עם היסטוריה) ---
    if (geminiKeys.length > 0) {
      console.log("[Gemini] מפעיל עדיפות ראשונה מול גוגל...");
      const geminiModels = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

      const geminiContents = [
        { role: "user", parts: [{ text: systemInstruction }] },
        { role: "model", parts: [{ text: "מבין, אענה בקצרה." }] }
      ];

      userSession.history.forEach((msg) => {
        geminiContents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }]
        });
      });

      if (isGroqTranscriptionWeak) {
        console.log("[Gemini Smart Fallback] התמלול של גרוק חלש, שולח את השמע ישירות לגימיני...");
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

      keyLoop:
      for (let i = 0; i < geminiKeys.length; i++) {
        const apiKey = geminiKeys[i];
        for (const model of geminiModels) {
          try {
            const response = await callGeminiWithRetry(model, payload, apiKey);
            if (response?.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
              finalAnswerText = response.data.candidates[0].content.parts[0].text;
              if (isGroqTranscriptionWeak) transcribedText = "[שמע שפוענח ישירות ע״י Gemini]";
              console.log(`[Gemini הצלחה] התקבלה תשובה מדגם ${model}!`);
              break keyLoop;
            }
          } catch (err) {}
        }
      }
    }

    // --- עדיפות 2 (גיבוי): OpenRouter (אם Gemini לא הגיב מסיבה כלשהי ויש טקסט מתומלל) ---
    if (!finalAnswerText && openRouterApiKey && transcribedText.length > 0 && !isGroqTranscriptionWeak) {
      try {
        console.log("[OpenRouter Backup] מפעיל גיבוי מול OpenRouter...");
        const messagesPayload = [
          { role: "system", content: systemInstruction },
          ...userSession.history,
          { role: "user", content: transcribedText }
        ];

        const openRouterCompletion = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          { model: "openrouter/free", messages: messagesPayload, temperature: 0.4 },
          { headers: { "Authorization": `Bearer ${openRouterApiKey}`, "Content-Type": "application/json" }, timeout: 5000 }
        );

        finalAnswerText = openRouterCompletion.data?.choices?.[0]?.message?.content || "";
        if (finalAnswerText) {
          console.log("[OpenRouter הצלחה] התקבלה תשובה משרת הגיבוי!");
        }
      } catch (err) {
        console.warn("[OpenRouter שגיאת גיבוי]:", err.message);
      }
    }

    if (!finalAnswerText) {
      finalAnswerText = "סליחה לא הבנתי את דבריך אנא נסה שנית";
    }

    const cleanText = finalAnswerText
      .replace(/[a-zA-Z]/g, "")                             
      .replace(/[.,?!:;'"״׳`_\-*~#–—&?=<>/()\\[\]{}]/g, " ") 
      .replace(/\d+\./g, "")                                 
      .replace(/\s+/g, " ")                                 
      .trim();

    console.log("תשובה סופית נקייה:", cleanText);

    if (transcribedText) {
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
    console.error("=== שגיאה כוללת במערכת ===", error.message);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-חלה שגיאה אנא נסה שנית&go_to_folder=/1`);
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
