const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));

// ======================================================
// זיכרון למניעת כפילויות רגעיות
// ======================================================

const processedCalls = new Map();

// ======================================================
// היסטוריית שיחה לפי מספר טלפון
// ======================================================

const conversationHistory = new Map();

// ======================================================
// ביטויי איפוס שיחה
// ======================================================

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

// ======================================================
// Ping / Health
// ======================================================

app.get("/ping", (req, res) => {
  res.status(200).send("PONG");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date()
  });
});

// ======================================================
// Gemini Retry
// ======================================================

const callGeminiWithRetry = async (
  model,
  payload,
  geminiApiKey,
  maxRetries = 2
) => {
  const geminiUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(
        geminiUrl,
        payload,
        {
          headers: {
            "Content-Type": "application/json"
          },
          timeout: 15000
        }
      );

      return response;

    } catch (err) {

      const status = err.response?.status;

      if (status === 429 && attempt < maxRetries) {

        const delay = 2000 * attempt;

        console.warn(
          `[Gemini 429] חריגת מכסה בדגם ${model}. ` +
          `מנסה שוב בעוד ${delay / 1000} שניות...`
        );

        await new Promise(resolve => setTimeout(resolve, delay));

      } else {
        throw err;
      }
    }
  }
};

// ======================================================
// ניקוי טקסט עבור ימות המשיח
//
// חשוב:
// לא משתמשים ב-encodeURIComponent!
// ימות מקבל את הטקסט העברי ישירות.
// ======================================================

const formatTextForYemot = (text) => {

  if (!text) {
    return "";
  }

  let clean = String(text)

    // הסרת Markdown בסיסי
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#`]/g, " ")

    // הסרת אותיות באנגלית
    .replace(/[a-zA-Z]/g, " ")

    // הסרת ירידות שורה וטאבים
    .replace(/[\n\r\t]/g, " ")

    // משאיר עברית, מספרים ורווחים
    .replace(/[^א-ת0-9\s]/g, " ")

    // איחוד רווחים
    .replace(/\s+/g, " ")

    .trim();

  return clean;
};

// ======================================================
// ניקוי תשובת AI
// ======================================================

const cleanAIAnswer = (text) => {

  if (!text) {
    return "";
  }

  let answer = String(text);

  answer = answer
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#`]/g, " ")
    .replace(/\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return answer;
};

// ======================================================
// מחיקת היסטוריה אחרי 10 דקות
// ======================================================

const resetSessionTimer = (userPhone, session) => {

  if (session.timer) {
    clearTimeout(session.timer);
  }

  session.timer = setTimeout(() => {

    console.log(
      `[History] עברו 10 דקות, ` +
      `מוחק היסטוריית שיחה עבור ${userPhone}`
    );

    conversationHistory.delete(userPhone);

  }, 10 * 60 * 1000);
};

// ======================================================
// טיפול בבקשת שמע
// ======================================================

const handleAudioRequest = async (req, res) => {

  try {

    // ==================================================
    // קבלת פרמטרים
    // ==================================================

    const params = {
      ...req.query,
      ...req.body
    };

    const callId =
      params.ApiCallId ||
      params.ApiYFCallId ||
      params.CallId ||
      "";

    const userPhone =
      params.ApiPhone ||
      params.phone ||
      params.ApiCallerId ||
      "default_user";

    const secondaryFolder =
      params.SHL ||
      "1";

    const primaryFolder =
      params.SHM ||
      "2";

    console.log("");
    console.log("==========================================");
    console.log("--- קריאה חדשה התקבלה ---");
    console.log("Call ID:", callId);
    console.log("Phone:", userPhone);
    console.log("SHL:", secondaryFolder);
    console.log("SHM:", primaryFolder);
    console.log("==========================================");

    // ==================================================
    // מניעת כפילות
    // ==================================================

    if (callId && processedCalls.has(callId)) {

      console.log(
        `[Cache] קריאה כפולה זוהתה עבור ${callId}`
      );

      processedCalls.delete(callId);

      res.set(
        "Content-Type",
        "text/plain; charset=utf-8"
      );

      return res.send(
        "go_to_folder=/1&"
      );
    }

    // ==================================================
    // API Keys
    // ==================================================

    const token =
      params.token ||
      params.TOKEN ||
      process.env.YEMOT_TOKEN ||
      "";

    const groqApiKey =
      (process.env.GROQ_API_KEY || "").trim();

    const openRouterApiKey =
      (process.env.OPENROUTER_API_KEY || "").trim();

    const geminiKeys = [
      (process.env.GEMINI_API_KEY || "").trim(),
      (process.env.GEMINI_API_KEY_1 || "").trim()
    ].filter(key => key.length > 0);

    // ==================================================
    // בדיקת Token
    // ==================================================

    if (!token) {

      console.error(
        "[שגיאה] לא נמצא Token של ימות המשיח"
      );

      const errorText =
        formatTextForYemot(
          "חסר טוקן של ימות המשיח"
        );

      res.set(
        "Content-Type",
        "text/plain; charset=utf-8"
      );

      return res.send(
        `id_list_message=t-${errorText}&go_to_folder=/1&`
      );
    }

    // ==================================================
    // הורדת הקלטה
    // ==================================================

    let audioBuffer = null;

    const possiblePaths = [];

    if (params.path) {
      possiblePaths.push(params.path);
    }

    if (params.file) {
      possiblePaths.push(params.file);
    }

    possiblePaths.push(
      `ivr2:/${secondaryFolder}/last.wav`
    );

    possiblePaths.push(
      `ivr2:/${primaryFolder}/last.wav`
    );

    console.log(
      "[Audio] נתיבים לבדיקה:",
      possiblePaths
    );

    for (const rawPath of possiblePaths) {

      let cleanPath;

      if (rawPath.startsWith("ivr2:")) {

        cleanPath = rawPath;

      } else if (rawPath.startsWith("/")) {

        cleanPath = `ivr2:${rawPath}`;

      } else {

        cleanPath = `ivr2:/${rawPath}`;
      }

      const downloadUrl =
        "https://www.call2all.co.il/ym/api/DownloadFile" +
        `?token=${encodeURIComponent(token)}` +
        `&path=${encodeURIComponent(cleanPath)}`;

      console.log(
        "[Audio] מנסה להוריד:",
        cleanPath
      );

      try {

        const audioResponse = await axios.get(
          downloadUrl,
          {
            responseType: "arraybuffer",
            timeout: 10000
          }
        );

        if (
          audioResponse.data &&
          audioResponse.data.length > 0
        ) {

          audioBuffer =
            Buffer.from(audioResponse.data);

          console.log(
            `[Audio] הקלטה הורדה בהצלחה. ` +
            `גודל: ${audioBuffer.length} bytes`
          );

          break;
        }

      } catch (err) {

        console.warn(
          `[Audio] לא ניתן להוריד ${cleanPath}:`,
          err.response?.status ||
          err.message
        );
      }
    }

    // ==================================================
    // אם אין הקלטה
    // ==================================================

    if (!audioBuffer) {

      console.error(
        "[שגיאה] לא נמצאה הקלטה תקינה."
      );

      const errText =
        formatTextForYemot(
          "לא נמצאה הקלטה תקינה אנא הקלט שוב"
        );

      res.set(
        "Content-Type",
        "text/plain; charset=utf-8"
      );

      return res.send(
        `id_list_message=t-${errText}&go_to_folder=/1&`
      );
    }

    // ==================================================
    // תמלול
    // ==================================================

    let transcribedText = "";

    if (groqApiKey) {

      try {

        console.log(
          "[Groq] מתחיל תמלול ב-Whisper..."
        );

        const boundary =
          "----YemotBoundary" +
          Math.random()
            .toString(36)
            .substring(2);

        let header = "";

        header +=
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="model"\r\n\r\n` +
          `whisper-large-v3-turbo\r\n`;

        header +=
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="language"\r\n\r\n` +
          `he\r\n`;

        header +=
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
          `תמלל בעברית בלבד ובאותיות עבריות.\r\n`;

        header +=
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
          `Content-Type: audio/wav\r\n\r\n`;

        const footer =
          `\r\n--${boundary}--\r\n`;

        const fullBuffer =
          Buffer.concat([
            Buffer.from(header, "utf8"),
            audioBuffer,
            Buffer.from(footer, "utf8")
          ]);

        const transcriptionResponse =
          await axios.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            fullBuffer,
            {
              headers: {
                "Authorization":
                  `Bearer ${groqApiKey}`,

                "Content-Type":
                  `multipart/form-data; boundary=${boundary}`
              },

              timeout: 20000
            }
          );

        transcribedText =
          transcriptionResponse.data?.text || "";

        transcribedText =
          transcribedText.trim();

        console.log(
          "[Groq] תמלול:",
          transcribedText
        );

      } catch (err) {

        console.error(
          "[Groq] שגיאת תמלול:",
          err.response?.status,
          err.response?.data ||
          err.message
        );
      }
    }

    // ==================================================
    // בדיקת איפוס
    // ==================================================

    const lowerTranscription =
      transcribedText
        .trim()
        .toLowerCase();

    const isResetRequested =
      RESET_TRIGGERS.some(
        trigger =>
          lowerTranscription.includes(
            trigger
          )
      );

    if (isResetRequested) {

      console.log(
        `[Reset] איפוס שיחה עבור ${userPhone}`
      );

      const existingSession =
        conversationHistory.get(userPhone);

      if (existingSession?.timer) {
        clearTimeout(existingSession.timer);
      }

      conversationHistory.delete(userPhone);

      if (callId) {

        processedCalls.set(
          callId,
          true
        );

        setTimeout(() => {
          processedCalls.delete(callId);
        }, 5000);
      }

      const resetText =
        formatTextForYemot(
          "השיחה אופסה בהצלחה במה אוכל לעזור"
        );

      res.set(
        "Content-Type",
        "text/plain; charset=utf-8"
      );

      return res.send(
        `id_list_message=t-${resetText}&go_to_folder=/1&`
      );
    }

    // ==================================================
    // טעינת היסטוריה
    // ==================================================

    let userSession =
      conversationHistory.get(userPhone);

    if (!userSession) {

      userSession = {
        history: [],
        timer: null
      };
    }

    resetSessionTimer(
      userPhone,
      userSession
    );

    // ==================================================
    // הוראת מערכת
    // ==================================================

    const systemInstruction =
      "אתה עוזר קולי בשיחת טלפון. " +
      "ענה בעברית פשוטה בלבד. " +
      "ללא רשימות. " +
      "ללא נקודתיים. " +
      "ללא אנגלית. " +
      "ענה במשפט אחד או שניים קצרים. " +
      "התבסס על היסטוריית השיחה. " +
      "התשובה מיועדת להקראה בטלפון.";

    let finalAnswerText = "";

    // ==================================================
    // OpenRouter
    // ==================================================

    if (
      openRouterApiKey &&
      transcribedText.length > 0
    ) {

      try {

        console.log(
          "[OpenRouter] שולח בקשה..."
        );

        const messagesPayload = [
          {
            role: "system",
            content: systemInstruction
          },

          ...userSession.history,

          {
            role: "user",
            content: transcribedText
          }
        ];

        const openRouterResponse =
          await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",

            {
              model: "openrouter/free",

              messages:
                messagesPayload,

              temperature: 0.6,

              max_tokens: 200
            },

            {
              headers: {
                "Authorization":
                  `Bearer ${openRouterApiKey}`,

                "Content-Type":
                  "application/json",

                "HTTP-Referer":
                  "https://render.com",

                "X-Title":
                  "Yemot Telephony AI"
              },

              timeout: 20000
            }
          );

        finalAnswerText =
          openRouterResponse
            .data
            ?.choices?.[0]
            ?.message
            ?.content || "";

        finalAnswerText =
          cleanAIAnswer(
            finalAnswerText
          );

        if (finalAnswerText) {

          console.log(
            "[OpenRouter] תשובה:",
            finalAnswerText
          );
        }

      } catch (err) {

        console.error(
          "[OpenRouter] שגיאה:",
          err.response?.status,
          err.response?.data ||
          err.message
        );
      }
    }

    // ==================================================
    // Gemini Fallback
    // ==================================================

    if (
      !finalAnswerText &&
      geminiKeys.length > 0
    ) {

      console.log(
        "[Gemini] מפעיל גיבוי..."
      );

      const geminiModels = [
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash"
      ];

      const geminiContents = [

        {
          role: "user",

          parts: [
            {
              text:
                systemInstruction
            }
          ]
        },

        {
          role: "model",

          parts: [
            {
              text:
                "מבין. אענה בקצרה בעברית ובהתאם להיסטוריית השיחה."
            }
          ]
        }
      ];

      // היסטוריה
      userSession.history.forEach(
        msg => {

          geminiContents.push({

            role:
              msg.role === "assistant"
                ? "model"
                : "user",

            parts: [
              {
                text:
                  msg.content
              }
            ]
          });
        }
      );

      // השאלה הנוכחית
      if (transcribedText) {

        geminiContents.push({

          role: "user",

          parts: [
            {
              text:
                transcribedText
            }
          ]
        });

      } else {

        geminiContents.push({

          role: "user",

          parts: [
            {
              text:
                "הקשב להקלטה וענה בעברית בקצרה."
            },

            {
              inlineData: {
                mimeType: "audio/wav",
                data:
                  audioBuffer.toString(
                    "base64"
                  )
              }
            }
          ]
        });
      }

      const payload = {
        contents:
          geminiContents
      };

      geminiLoop:

      for (
        let i = 0;
        i < geminiKeys.length;
        i++
      ) {

        const apiKey =
          geminiKeys[i];

        console.log(
          `[Gemini] מנסה מפתח ${i + 1}`
        );

        for (
          const model of geminiModels
        ) {

          try {

            console.log(
              `[Gemini] מנסה דגם ${model}`
            );

            const response =
              await callGeminiWithRetry(
                model,
                payload,
                apiKey
              );

            const text =
              response
                ?.data
                ?.candidates?.[0]
                ?.content
                ?.parts?.[0]
                ?.text;

            if (text) {

              finalAnswerText =
                cleanAIAnswer(text);

              console.log(
                `[Gemini] התקבלה תשובה:`,
                finalAnswerText
              );

              break geminiLoop;
            }

          } catch (err) {

            console.error(
              `[Gemini] מפתח ${i + 1}, ` +
              `דגם ${model}:`,
              err.response?.status,
              err.response?.data ||
              err.message
            );
          }
        }
      }
    }

    // ==================================================
    // אין תשובה
    // ==================================================

    if (!finalAnswerText) {

      throw new Error(
        "לא התקבלה תשובה מ-OpenRouter או Gemini"
      );
    }

    // ==================================================
    // ניקוי לתשובה של ימות
    // ==================================================

    const cleanText =
      formatTextForYemot(
        finalAnswerText
      );

    console.log(
      "[Yemot] טקסט להקראה:",
      cleanText
    );

    // ==================================================
    // עדכון היסטוריה
    // ==================================================

    if (transcribedText) {

      userSession.history.push({

        role: "user",

        content:
          transcribedText
      });

      userSession.history.push({

        role: "assistant",

        content:
          finalAnswerText
      });

      // שומר רק את 10 ההודעות האחרונות
      if (
        userSession.history.length > 10
      ) {

        userSession.history =
          userSession.history.slice(-10);
      }

      conversationHistory.set(
        userPhone,
        userSession
      );
    }

    // ==================================================
    // שמירת Call ID
    // ==================================================

    if (callId) {

      processedCalls.set(
        callId,
        true
      );

      setTimeout(() => {

        processedCalls.delete(
          callId
        );

      }, 5000);
    }

    // ==================================================
    // תשובה לימות המשיח
    //
    // חשוב מאוד:
    // אין encodeURIComponent
    // ==================================================

    res.set(
      "Content-Type",
      "text/plain; charset=utf-8"
    );

    const yemotResponse =
      `id_list_message=t-${cleanText}&go_to_folder=/1&`;

    console.log(
      "[Yemot] תשובת API:",
      yemotResponse
    );

    return res.send(
      yemotResponse
    );

  } catch (error) {

    // ==================================================
    // שגיאה כללית
    // ==================================================

    console.error(
      "=========================================="
    );

    console.error(
      "=== שגיאה כוללת במערכת ==="
    );

    console.error(
      error.stack ||
      error.message
    );

    console.error(
      "=========================================="
    );

    const errFormatted =
      formatTextForYemot(
        "חלה שגיאה בעיבוד ההודעה אנא נסה שנית"
      );

    res.set(
      "Content-Type",
      "text/plain; charset=utf-8"
    );

    return res.send(
      `id_list_message=t-${errFormatted}&go_to_folder=/1&`
    );
  }
};

// ======================================================
// Routes
// ======================================================

app.all(
  "/",
  handleAudioRequest
);

app.all(
  "/process-audio",
  handleAudioRequest
);

// ======================================================
// Server
// ======================================================

const PORT =
  process.env.PORT || 10000;

app.listen(
  PORT,
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

  }
);
