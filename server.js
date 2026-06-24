require("dotenv").config();
console.log("🚀 SERVER START");

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

// ================== CORS ==================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());

// ================== LOGGER ==================
app.use((req, res, next) => {
  console.log(req.method, req.url);
  next();
});

let db = null;

// ================== HEALTH CHECK ==================
app.get("/", (req, res) => {
  res.json({ status: "OK", server: "AI Backend Running", dbConnected: !!db });
});

// ================== MIGRASI ==================
async function runMigrations(database) {
  console.log("📦 Menjalankan migrasi...");
  const createUsersTable =
    "CREATE TABLE IF NOT EXISTS users (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "username VARCHAR(50)," +
    "email VARCHAR(100)," +
    "password VARCHAR(255)," +
    "learning_style VARCHAR(20) DEFAULT 'reading'," +
    "visual_score FLOAT DEFAULT 0," +
    "auditory_score FLOAT DEFAULT 0," +
    "reading_score FLOAT DEFAULT 0," +
    "kinesthetic_score FLOAT DEFAULT 0)";
  await database.execute(createUsersTable);

  const createClassificationRulesTable =
    "CREATE TABLE IF NOT EXISTS classification_rules (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "visual_weight FLOAT DEFAULT 1," +
    "auditory_weight FLOAT DEFAULT 1," +
    "reading_weight FLOAT DEFAULT 1," +
    "kinesthetic_weight FLOAT DEFAULT 1)";
  await database.execute(createClassificationRulesTable);

  const [rules] = await database.execute("SELECT COUNT(*) cnt FROM classification_rules");
  if (rules[0].cnt === 0) {
    await database.execute(
      "INSERT INTO classification_rules (visual_weight,auditory_weight,reading_weight,kinesthetic_weight) VALUES (1,1,1,1)"
    );
  }

  const createActivitiesTable =
    "CREATE TABLE IF NOT EXISTS activities (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "title VARCHAR(200)," +
    "type ENUM('video','teks','praktik')," +
    "content_url VARCHAR(500)," +
    "style_target ENUM('visual','auditory','reading','kinesthetic'))";
  await database.execute(createActivitiesTable);

  const createQuizzesTable =
    "CREATE TABLE IF NOT EXISTS ai_generated_quizzes (" +
    "id INT AUTO_INCREMENT PRIMARY KEY," +
    "user_id INT," +
    "topic VARCHAR(200)," +
    "num_questions INT," +
    "questions LONGTEXT," +
    "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)";
  await database.execute(createQuizzesTable);

  console.log("✅ Migrasi selesai");
}

// ================== KONEKSI DB ==================
(async () => {
  try {
    db = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });
    console.log("✅ Database terhubung");
    await runMigrations(db);
  } catch (err) {
    console.error("❌ Database gagal:", err.message);
    db = null;
  }
})();

// ================== ANALYZE ==================
app.post("/analyze", async (req, res) => {
  try {
    const { answers } = req.body;
    if (!Array.isArray(answers) || answers.length !== 8) {
      return res.status(400).json({ success: false, message: "Jawaban tidak lengkap" });
    }
    const scores = { visual: 0, auditory: 0, reading: 0, kinesthetic: 0 };
    answers.forEach(a => { if (scores.hasOwnProperty(a)) scores[a]++; });

    const learning_style = Object.keys(scores).reduce((a, b) => scores[a] > scores[b] ? a : b);

    let activities = [];
    if (db) {
      const [rows] = await db.execute(
        "SELECT id, title, type, content_url, style_target FROM activities WHERE style_target = ?",
        [learning_style]
      );
      activities = rows || [];
    }
    return res.json({ success: true, learning_style, scores, activities });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ================== HELPER: GEMINI ==================
async function generateWithGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY belum diatur");
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const result = await model.generateContent(prompt);
  const response = result.response;
  const text = response.text();
  if (!text) throw new Error("Gemini tidak menghasilkan teks");
  return text;
}

// ================== HELPER: OPENROUTER (FALLBACK) ==================
const OPENROUTER_MODELS = [
  "mistralai/mistral-7b-instruct:free",
  "deepseek/deepseek-chat:free",
  "meta-llama/llama-3.3-70b-instruct:free"
];

async function generateWithOpenRouter(prompt) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY tidak tersedia");
  }
  let lastError = null;
  for (const model of OPENROUTER_MODELS) {
    try {
      console.log(`Mencoba model OpenRouter: ${model}`);
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.OPENROUTER_API_KEY,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://backend-nodejs-production-122d.up.railway.app",
          "X-Title": "elearning-ai"
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: "Jawab HANYA dengan JSON tanpa penjelasan." },
            { role: "user", content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 2000
        })
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenRouter Error ${response.status}: ${errText}`);
      }
      const data = await response.json();
      if (!data.choices?.[0]?.message) throw new Error("Respons AI tidak valid");
      return data.choices[0].message.content;
    } catch (err) {
      console.warn(`Model ${model} gagal:`, err.message);
      lastError = err;
    }
  }
  throw lastError || new Error("Semua model OpenRouter gagal");
}

// ================== GENERATE QUIZ ==================
app.post("/generate-quiz", async (req, res) => {
  try {
    const {
      topic = "umum",
      numQuestions = 3,
      learningStyle = "reading",
      userId = null
    } = req.body;
    const jumlah = Number(numQuestions) || 3;

    const prompt =
      `Buat ${jumlah} soal pilihan ganda tentang "${topic}" dengan gaya belajar "${learningStyle}". ` +
      `Format output HARUS JSON seperti berikut: ` +
      `[{"question": "Pertanyaan", "options": ["A. ...", "B. ...", "C. ...", "D. ..."], "correct": "A", "explanation": "Penjelasan"}] ` +
      `Jangan tambahkan teks apa pun selain JSON.`;

    let raw = null;
    let usedProvider = "";

    // Coba Gemini dulu
    if (process.env.GEMINI_API_KEY) {
      try {
        raw = await generateWithGemini(prompt);
        usedProvider = "Gemini";
        console.log("✅ Berhasil menggunakan Gemini");
      } catch (geminiErr) {
        console.error("Gemini gagal:", geminiErr.message);
        // Jika Gemini gagal, coba OpenRouter (jika tersedia)
        if (process.env.OPENROUTER_API_KEY) {
          try {
            raw = await generateWithOpenRouter(prompt);
            usedProvider = "OpenRouter (fallback)";
            console.log("✅ Beralih ke OpenRouter");
          } catch (openRouterErr) {
            console.error("OpenRouter juga gagal:", openRouterErr.message);
            throw new Error(`Gemini gagal: ${geminiErr.message}. OpenRouter juga gagal: ${openRouterErr.message}`);
          }
        } else {
          throw new Error(`Gemini gagal: ${geminiErr.message}. OpenRouter tidak dikonfigurasi.`);
        }
      }
    } else if (process.env.OPENROUTER_API_KEY) {
      // Jika tidak ada Gemini, langsung coba OpenRouter
      raw = await generateWithOpenRouter(prompt);
      usedProvider = "OpenRouter";
    } else {
      throw new Error("Tidak ada penyedia AI yang dikonfigurasi (GEMINI_API_KEY atau OPENROUTER_API_KEY)");
    }

    // Bersihkan markdown
    const tick = "```";
    raw = raw.replace(tick + "json", "").replace(tick, "").trim();
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1) throw new Error("Format JSON tidak ditemukan");

    const jsonText = raw.substring(start, end + 1);
    let questionsArray = JSON.parse(jsonText);
    if (!Array.isArray(questionsArray)) questionsArray = [questionsArray];

    // Simpan ke DB
    if (db) {
      try {
        await db.execute(
          "INSERT INTO ai_generated_quizzes (user_id, topic, num_questions, questions) VALUES (?, ?, ?, ?)",
          [userId, topic, jumlah, JSON.stringify(questionsArray)]
        );
        console.log("✅ Quiz disimpan");
      } catch (dbErr) {
        console.warn("⚠️ Gagal simpan quiz:", dbErr.message);
      }
    }

    return res.json({
      success: true,
      questions: questionsArray,
      provider: usedProvider
    });
  } catch (err) {
    console.error("Generate Quiz Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ================== UPDATE PERFORMANCE ==================
app.post("/update_performance", (req, res) => {
  res.json({ success: true, new_learning_style: "reading" });
});

// ================== GET ALL ACTIVITIES ==================
app.get("/activities", async (req, res) => {
  if (!db) return res.status(500).json({ success: false, message: "Database tidak terhubung" });
  const [activities] = await db.execute("SELECT id, title, type, content_url, style_target FROM activities ORDER BY id DESC");
  res.json({ success: true, activities });
});

// ================== ADD ACTIVITY ==================
app.post("/add-activity", async (req, res) => {
  if (!db) return res.status(500).json({ success: false, message: "Database tidak terhubung" });
  const { title, type, content_url, style_target } = req.body;
  if (!title || !type || !content_url || !style_target) return res.status(400).json({ success: false, message: "Data tidak lengkap" });
  await db.execute("INSERT INTO activities (title, type, content_url, style_target) VALUES (?, ?, ?, ?)", [title, type, content_url, style_target]);
  res.json({ success: true, message: "Aktivitas ditambahkan" });
});

// ================== DELETE ACTIVITY ==================
app.delete("/activity/:id", async (req, res) => {
  if (!db) return res.status(500).json({ success: false, message: "Database tidak terhubung" });
  await db.execute("DELETE FROM activities WHERE id = ?", [req.params.id]);
  res.json({ success: true, message: "Aktivitas dihapus" });
});

// ================== SEED ACTIVITIES ==================
app.post("/seed-activities", async (req, res) => {
  if (!db) return res.status(500).json({ success: false, message: "Database tidak terhubung" });
  const sample = [
    { title: "Video - Matematika", type: "video", content_url: "https://www.youtube.com/embed/dQw4w9WgXcQ", style_target: "visual" },
    { title: "Teks - Sejarah", type: "teks", content_url: "https://example.com/sejarah.html", style_target: "reading" },
    { title: "Praktik - Coding JS", type: "praktik", content_url: "https://example.com/js-practice", style_target: "kinesthetic" },
    { title: "Audio - Bhs Inggris", type: "video", content_url: "https://www.youtube.com/embed/example", style_target: "auditory" },
    { title: "Infografis - Biologi", type: "video", content_url: "https://www.youtube.com/embed/biology", style_target: "visual" }
  ];
  let count = 0;
  for (const a of sample) {
    try {
      await db.execute("INSERT INTO activities (title, type, content_url, style_target) VALUES (?, ?, ?, ?)", [a.title, a.type, a.content_url, a.style_target]);
      count++;
    } catch (e) { console.warn("Mungkin sudah ada:", e.message); }
  }
  res.json({ success: true, message: `${count} aktivitas ditambahkan` });
});

// ================== START ==================
app.listen(PORT, () => console.log(`✅ Server berjalan di port ${PORT}`));
