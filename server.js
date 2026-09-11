const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.all("/", async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    console.log("Incoming request params:", params);

    // ניתוק שיחה
    if (params.hangup === "yes") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("");
    }

    const voiceFileUrl = params.val_1 || params.ApiVoiceFile || params.ApiVoiceFileName;

    // כניסה ראשונית לשלוחה
    if (!voiceFileUrl) {
      const responseText = "id_list_message=t-שלום במה אוכל לעזור לך&read_mode=record&read_max=120&read_time_out=3&val_name=val_1";
      res.writeHead(200, { 
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(responseText)
      });
      return res.end(responseText);
    }

    // קבלת קובץ השמע ועיבוד ב-Gemini
    const audioResponse = await axios.get(voiceFileUrl, { responseType: "arraybuffer" });
    const audioBuffer = Buffer.from(audioResponse.data);

    const geminiResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "audio/wav",
                data: audioBuffer.toString("base64")
              }
            },
            {
              text: "אתה עוזר קולי בשיחת טלפון. ענה בעברית פשוטה, קצרה וברורה (עד 2 משפטים). אל תשתמש באימוג'ים או תווים מיוחדים."
            }
          ]
        }
      ]
    });

    const replyText = geminiResponse.text.replace(/["'\n\r&]/g, " ");
    const responseText = `id_list_message=t-${replyText}&read_mode=record&read_max=120&read_time_out=3&val_name=val_1`;

    res.writeHead(200, { 
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(responseText)
    });
    return res.end(responseText);

  } catch (error) {
    console.error("Error processing request:", error);
    const errorText = "id_list_message=t-חלה שגיאה אנא נסה שוב&read_mode=record&read_max=120&read_time_out=3&val_name=val_1";
    res.writeHead(200, { 
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(errorText)
    });
    return res.end(errorText);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
