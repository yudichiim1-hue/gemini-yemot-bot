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

const formatTextForYemot = (text) => {
  if (!text) return "";
  return text
    .replace(/[^א-ת0-9\s]/g, "") // מנקה לחלוטין כל מה שאינו עברית, מספר או רווח
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

    console.log("\n--- קריאה חדשה התקבלה ---");
    console.log("Call ID:", callId);

    if (callId && processedCalls.has(callId)) {
      processedCalls.delete(callId);
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send("go_to_folder=/1");
    }

    const token = params.token || params.TOKEN || "WU1BUElL.apik_H8E4CZtg_8iQ0kMQLYzFrw.X5JSBHi5D-dw_BWfX_3vIrgoR9jYSzUdiITDwdsIHCM";
    const groqApiKey = (process.env.GROQ_API_KEY || "").trim();
    const geminiApiKey = (process.env.GEMINI_API_KEY || "").trim();

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
        const audioResponse = await axios.get(downloadUrl, { responseType: "arraybuffer", timeout: 4000 });
        if (audioResponse.data && audioResponse.data.length > 0) {
          audioBuffer = Buffer.from(audioResponse.data);
          break;
        }
      } catch (err) {}
    }

    if (!audioBuffer) {
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send("id_list_message=m-לא נמצאה הקלטה תקינה");
    }

    let transcribedText = "";

    // תמלול ב-Groq
    if (groqApiKey) {
      try {
        const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
        let formDataHeader = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n`;
        formDataHeader += `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nhe\r\n`;
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
            timeout: 5000
          }
        );
        transcribedText = transcriptionResponse.data?.text || "";
      } catch (err) {}
    }

    let finalAnswerText = "";
    const systemInstruction = "ענה בעברית פשוטה בלבד, ללא סימני פיסוק, ללא מספרים, עד 2 משפטים.";

    // תשובה מ-Gemini (ישיר ובטוח)
    if (geminiApiKey) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiApiKey}`;
        const response = await axios.post(geminiUrl, {
          contents: [
            { role: "user", parts: [{ text: systemInstruction }, { text: transcribedText || "שלום" }] }
          ]
        }, { timeout: 6000 });

        finalAnswerText = response.data?.candidates??. [0]?.content?.parts?.[0]?.text || "";
      } catch (err) {}
    }

    if (!finalAnswerText) {
      finalAnswerText = "שגיאה בעיבוד הנתונים";
    }

    const cleanText = formatTextForYemot(finalAnswerText);

    if (callId) {
      processedCalls.set(callId, true);
      setTimeout(() => processedCalls.delete(callId), 5000);
    }

    // פורמט תגובה נקי לחלוטין בלי שום תווים מיותרים שיכולים להכשיל את ימות המשיח
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(`id_list_message=m-${encodeURIComponent(cleanText)}`);

  } catch (error) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send("id_list_message=m-שגיאה במערכת");
  }
};

app.all("/", handleAudioRequest);
app.all("/process-audio", handleAudioRequest);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
