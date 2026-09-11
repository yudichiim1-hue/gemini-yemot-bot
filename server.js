const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// פונקציית עזר להשהיה בין ניסיונות הורדה
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// פונקציה להורדת הקובץ עם ניסיונות חוזרים (מטפלת בדיליי כתיבה)
async function downloadAudioWithRetry(url, retries = 3, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { responseType: "arraybuffer" });
      if (response.status === 200 && response.data.length > 0) {
        return response.data;
      }
    } catch (err) {
      console.log(`Download attempt ${i + 1} failed. Retrying in ${delayMs}ms...`);
      if (i === retries - 1) throw err;
      await sleep(delayMs);
    }
  }
}

app.all("/process-audio", async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    console.log("Incoming call params:", params);

    let voiceFileUrl = params.file || params.val_1 || params.ApiVoiceFile || params.path || params.ym_file_path || params.recording_url;

    if (!voiceFileUrl || voiceFileUrl === "yes") {
      if (params.ApiCallId) {
        voiceFileUrl = `ivr2:/2/${params.ApiCallId}.wav`;
      }
    }

    if (!voiceFileUrl) {
      console.log("No file URL found.");
      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.send("id_list_message=t-לא התקבל קובץ הקלטה אנא נסה שנית&go_to_folder=/1");
    }

    if (!voiceFileUrl.startsWith("http")) {
      const systemToken = params.token || "";
      voiceFileUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${systemToken}&path=${voiceFileUrl}`;
    }

    console.log("Downloading audio from:", voiceFileUrl);

    // הורדה עם 3 ניסיונות והשהיה של שנייה בין ניסיון לניסיון
    const audioData = await downloadAudioWithRetry(voiceFileUrl, 3, 1000);
    const audioBuffer = Buffer.from(audioData);

    // שליחה ל-Gemini Flash 2.5
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

    // השמעת התשובה והחזרה אוטומטית לשלוחה 1
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(`id_list_message=t-${replyText}&go_to_folder=/1`);

  } catch (error) {
    console.error("Error processing request:", error);
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send("id_list_message=t-חלה שגיאה בעיבוד ההודעה אנא נסה שנית&go_to_folder=/1");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
