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

const callGeminiWithRetry = async (model, payload, geminiApiKey, maxRetries = 1) => {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(geminiUrl, payload, { 
        headers: { "Content-Type": "application/json" }, 
        timeout: 12000 
      });
      return response;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < maxRetries) {
        const delay = 1000 * attempt; 
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
};

const formatTextForYemot = (text) => {
  if (!text) return "";
  return text
    .replace(/[^א-ת0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

const handleAudioRequest = async (req, res) => {
  const startTime = Date.now();
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
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 8000 });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          break;
        }
      } catch (err) {
        // ממשיך הלאה אם הנתיב נכשל
      }
    }

    if (!audioBuffer) {
      console.error("[שגיאה] לא נמצאה הקלטה תקינה.");
      res.set("Content-Type", "text/plain; charset=utf-8");
      const errText = formatTextForYemot("לא נמצאה הקלטה תקינה אנא הקלט שוב");
      return res.send(`id_list_message=m-${encodeURIComponent(errText)}&go_to_folder=/1`);
    }

    let transcribedText = "";

    if (groqApiKey) {
      try {
        const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
        let formDataHeader = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n`;
        formDataHeader += `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nhe\r\n`;
        formDataHeader += `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nתמלל בעברית בלבד ובאותיות עבריות.\r\n`;
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

        transcribedText = transcriptionResponse.data?.text || "";
      } catch (err) {
        console.error("[Groq שגיאת תמלול]:", err.message);
      }
    }

    const lowerTranscription = transcribedText.trim().toLowerCase();
    const isResetRequested = RESET_TRIGGERS.some(trigger => lowerTranscription.includes(trigger));

    if (isResetRequested) {
      const existingSession = conversationHistory.get(userPhone);
      if (existingSession?.timer) clearTimeout(existingSession.timer);
      conversationHistory.delete(userPhone);

      if (callId) {
        processedCalls.set(callId, true);
        setTimeout(() => processedCalls.delete(callId), 5000);
      }

      res.set("Content-Type", "text/plain; charset=utf-8");
      const resetText = formatTextForYemot("השיחה אופסה בהצלחה במה אוכל לעזור");
      return res.send(`id_list_message=m-${encodeURIComponent(resetText)}&go_to_folder=/1`);
    }

    let userSession = conversationHistory.get(userPhone) || { history: [], timer: null };
    
    if (userSession.timer) clearTimeout(userSession.timer);
    userSession.timer = setTimeout(() => {
      conversationHistory.delete(userPhone);
    }, 10 * 60 * 1000);

    let finalAnswerText = "";
    const systemInstruction = "אתה עוזר קולי בשיחת טלפון. ענה בעברית פשוטה בלבד, ללא רשימות, ללא מספרים, ללא נקודתיים, ללא סימני פיסוק, וללא אנגלית. עד 2 משפטים רציפים. התבסס על היסטוריית השיחה.";

    if (openRouterApiKey && transcribedText.trim().length > 0) {
      try {
        const messagesPayload = [
          { role: "system", content: systemInstruction },
          ...userSession.history,
          { role: "user", content: transcribedText }
        ];

        const openRouterCompletion = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            model: "openrouter/free",
            messages: messagesPayload,
            temperature: 0.6
          },
          {
            headers: {
              "Authorization": `Bearer ${openRouterApiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://render.com",
              "X-Title": "Yemot Telephony AI"
            },
            timeout: 12000
          }
        );

        finalAnswerText = openRouterCompletion.data?.choices?.[0]?.message?.content || "";
      } catch (err) {
        console.error("[OpenRouter שגיאה]:", err.message);
      }
    }

    if (!finalAnswerText && geminiKeys.length > 0) {
      const geminiModels = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];
      const geminiContents = [
        { role: "user", parts: [{ text: systemInstruction }] },
        { role: "model", parts: [{ text: "מבין, אענה בקצרה בהתאם להנחיות ובהתבסס על ההיסטוריה." }] }
      ];

      userSession.history.forEach((msg) => {
        geminiContents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }]
        });
      });

      if (transcribedText) {
        geminiContents.push({ role: "user", parts: [{ text: transcribedText }] });
      } else {
        geminiContents.push({
          role: "user",
          parts: [
            { text: "ענה בקצרה בהתאם להקלטה:" },
            { inlineData: { mimeType: "audio/wav", data: audioBuffer.toString("base64") } }
          ]
        });
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
              break keyLoop;
            }
          } catch (err) {
            // ממשיך לנסות מפתח/דגם הבא
          }
        }
      }
    }

    if (!finalAnswerText) {
      finalAnswerText = "לא הצלחתי לעבד את הבקשה אנא נסה שנית";
    }

    const cleanText = formatTextForYemot(finalAnswerText);
    console.log(`זמן כולל לעיבוד: ${Date.now() - startTime}ms`);

    if (transcribedText) {
      userSession.history.push({ role: "user", content: transcribedText });
      userSession.history.push({ role: "assistant", content: finalAnswerText });
      conversationHistory.set(userPhone, userSession);
    }

    if (callId) {
      processedCalls.set(callId, true);
      setTimeout(() => processedCalls.delete(callId), 5000);
    }

    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=m-${encodeURIComponent(cleanText)}&go_to_folder=/1`);

  } catch (error) {
    console.error("=== שגיאה כוללת במערכת ===");
    console.error(error.stack || error.message);
    res.set("Content-Type", "text/plain; charset=utf-8");
    const errFormatted = formatTextForYemot("חלה שגיאה בעיבוד ההודעה אנא נסה שנית");
    return res.send(`id_list_message=m-${encodeURIComponent(errFormatted)}&go_to_folder=/1`);
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
