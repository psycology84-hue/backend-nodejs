require("dotenv").config();

console.log("🚀 SERVER START");



const express = require("express");

const cors = require("cors");

const mysql = require("mysql2/promise");



const app = express();

const PORT = process.env.PORT || 3000;



// ================== CORS FIX ==================

app.use(cors({

  origin: "*",

  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],

  allowedHeaders: ["Content-Type", "Authorization"]

}));



// Custom CORS middleware untuk Express 5 compatibility

app.use((req, res, next) => {

  res.header("Access-Control-Allow-Origin", "*");

  res.header(

    "Access-Control-Allow-Headers",

    "Origin, X-Requested-With, Content-Type, Accept, Authorization"

  );

  res.header(

    "Access-Control-Allow-Methods",

    "GET, POST, PUT, DELETE, OPTIONS"

  );

  if (req.method === "OPTIONS") {

    return res.sendStatus(200);

  }

  next();

});


app.use(express.json());

// ================== LOGGER ==================

app.use((req, res, next) => {

  console.log(req.method, req.url);

  next();

});



let db = null;



// ================== CEK API KEY ==================

if (!process.env.OPENROUTER_API_KEY) {

  console.warn("⚠️ OPENROUTER_API_KEY belum diatur");

} else {

  console.log("✅ OpenRouter API Key ditemukan");

}



// ================== HEALTH CHECK ==================

app.get("/", (req, res) => {

  res.json({

    status: "OK",

    server: "AI Backend Running",

    dbConnected: !!db

  });

});

// ================== TEST ROUTE ==================

app.get("/test", (req, res) => {

  res.send("SERVER HIDUP");

});



// ================== MIGRASI ==================

async function runMigrations(database) {

  console.log("📦 Menjalankan migrasi...");



  // Create users table

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



  // Create classification_rules table

  const createClassificationRulesTable =

    "CREATE TABLE IF NOT EXISTS classification_rules (" +

    "id INT AUTO_INCREMENT PRIMARY KEY," +

    "visual_weight FLOAT DEFAULT 1," +

    "auditory_weight FLOAT DEFAULT 1," +

    "reading_weight FLOAT DEFAULT 1," +

    "kinesthetic_weight FLOAT DEFAULT 1)";



  await database.execute(createClassificationRulesTable);



  const [rules] = await database.execute(

    "SELECT COUNT(*) cnt FROM classification_rules"

  );



  if (rules[0].cnt === 0) {

    const insertDefaultRules =

      "INSERT INTO classification_rules " +

      "(visual_weight,auditory_weight,reading_weight,kinesthetic_weight) " +

      "VALUES (1,1,1,1)";

    

    await database.execute(insertDefaultRules);

  }



  // Create activities table

  const createActivitiesTable =

    "CREATE TABLE IF NOT EXISTS activities (" +

    "id INT AUTO_INCREMENT PRIMARY KEY," +

    "title VARCHAR(200)," +

    "type ENUM('video','teks','praktik')," +

    "content_url VARCHAR(500)," +

    "style_target ENUM('visual','auditory','reading','kinesthetic'))";



  await database.execute(createActivitiesTable);



  // Create ai_generated_quizzes table

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



// ================== KONEKSI DATABASE ==================

(async () => {

  try {



    console.log("DB_HOST:", process.env.DB_HOST);

    console.log("DB_PORT:", process.env.DB_PORT);

    console.log("DB_USER:", process.env.DB_USER);

    console.log("DB_NAME:", process.env.DB_NAME);



    db = await mysql.createConnection({

      host: process.env.DB_HOST,

      port: process.env.DB_PORT,

      user: process.env.DB_USER,

      password: process.env.DB_PASSWORD,

      database: process.env.DB_NAME

    });



    console.log("✅ Database terhubung");



    await runMigrations(db);



  } catch(err){



    console.error("❌ Database gagal:");

    console.error(err.message);



    db = null;



    console.log("⚠️ Server tetap berjalan tanpa database");

  }

})();



// ================== ANALYZE ==================

app.post("/analyze", async (req, res) => {

  try {

    const { answers } = req.body;



    if (!Array.isArray(answers) || answers.length !== 8) {

      return res.status(400).json({

        success: false,

        message: "Jawaban tidak lengkap"

      });

    }



    const scores = {

      visual: 0,

      auditory: 0,

      reading: 0,

      kinesthetic: 0

    };



    answers.forEach(a => {

      if (scores.hasOwnProperty(a)) {

        scores[a]++;

      }

    });



    const learning_style = Object.keys(scores).reduce((a, b) =>

      scores[a] > scores[b] ? a : b

    );



    return res.json({

      success: true,

      learning_style,

      scores,

      activities: []

    });



  } catch (err) {

    console.error(err);

    res.status(500).json({

      success: false,

      message: err.message

    });

  }

});



// ================== GENERATE QUIZ ==================

app.post("/generate-quiz", async (req, res) => {

  try {

    if (!process.env.OPENROUTER_API_KEY) {

      return res.status(500).json({

        success: false,

        message: "OPENROUTER_API_KEY belum diisi"

      });

    }



    const {

      topic = "umum",

      numQuestions = 3,

      learningStyle = "reading",

      userId = null

    } = req.body;



    const jumlah = Number(numQuestions) || 3;



    const prompt = 

      "Buat " + jumlah + " soal pilihan ganda tentang \"" + topic + "\" " +

      "dengan gaya belajar \"" + learningStyle + "\". " +

      "Format output HARUS JSON seperti berikut: " +

      "[{\"question\": \"Pertanyaan\", \"options\": [\"A. ...\", \"B. ...\", \"C. ...\", \"D. ...\"], " +

      "\"correct\": \"A\", \"explanation\": \"Penjelasan\"}] " +

      "Jangan tambahkan teks apa pun selain JSON.";



    // Timeout 30 detik

    const controller = new AbortController();



    const timeout = setTimeout(() => {

      controller.abort();

    }, 30000);



    let response;



    try {

      response = await fetch(

        "https://openrouter.ai/api/v1/chat/completions",

        {

          method: "POST",

          signal: controller.signal,

          headers: {

            Authorization: "Bearer " + process.env.OPENROUTER_API_KEY,

            "Content-Type": "application/json",

            "HTTP-Referer":

              "https://backend-nodejs-production-714f.up.railway.app",

            "X-Title": "elearning-ai"

          },

          body: JSON.stringify({

            model: "meta-llama/llama-3.3-70b-instruct:free",

            messages: [

              {

                role: "system",

                content:

                  "Kamu adalah generator soal. Jawab HANYA dengan JSON tanpa penjelasan tambahan."

              },

              {

                role: "user",

                content: prompt

              }

            ],

            temperature: 0.7,

            max_tokens: 2000

          })

        }

      );

    } finally {

      clearTimeout(timeout);

    }



    // Cek response OpenRouter

    if (!response.ok) {

      const errorText = await response.text();



      throw new Error(

        "OpenRouter Error " + response.status + ": " + errorText

      );

    }



    const data = await response.json();



    console.log(

      "OpenRouter Response:",

      JSON.stringify(data).substring(0, 500)

    );



    // Validasi struktur respons

    if (

      !data.choices ||

      !data.choices.length ||

      !data.choices[0].message

    ) {

      throw new Error(

        "Tidak ada respons valid dari AI"

      );

    }



    let raw = data.choices[0].message.content.trim();



    // Bersihkan markdown jika AI membungkus dalam code fences

    const tick = String.fromCharCode(96);

    const codeMarker = tick + tick + tick;

    raw = raw.split(codeMarker + "json").join("")

      .split(codeMarker).join("")

      .trim();



    // Cari posisi JSON array

    const start = raw.indexOf("[");

    const end = raw.lastIndexOf("]");



    if (start === -1 || end === -1) {

      console.error(

        "AI menghasilkan format aneh:",

        raw

      );



      throw new Error(

        "AI tidak menghasilkan JSON valid"

      );

    }



    const jsonText = raw.substring(

      start,

      end + 1

    );



    let questionsArray;



    try {

      questionsArray = JSON.parse(jsonText);

    } catch (parseError) {

      console.error(

        "JSON Parse Error:"

      );



      console.error(jsonText);



      throw new Error(

        "AI menghasilkan JSON tidak valid"

      );

    }



    // Pastikan selalu array

    if (!Array.isArray(questionsArray)) {

      questionsArray = [questionsArray];

    }



    // Simpan ke database (opsional)

    if (db) {

      try {

        const insertQuery =

          "INSERT INTO ai_generated_quizzes " +

          "(user_id, topic, num_questions, questions) " +

          "VALUES (?, ?, ?, ?)";



        await db.execute(insertQuery, [

          userId,

          topic,

          jumlah,

          JSON.stringify(questionsArray)

        ]);



        console.log("✅ Quiz berhasil disimpan");



      } catch (dbErr) {

        console.warn(

          "⚠️ Gagal simpan quiz:",

          dbErr.message

        );

      }

    }



    return res.json({

      success: true,

      questions: questionsArray

    });



  } catch (err) {



    console.error(

      "Generate Quiz Error:",

      err

    );



    if (err.name === "AbortError") {

      return res.status(408).json({

        success: false,

        message:

          "Request AI timeout. Coba lagi."

      });

    }



    return res.status(500).json({

      success: false,

      message:

        err.message ||

        "Terjadi kesalahan server"

    });

  }

});

// ================== UPDATE PERFORMANCE ==================

app.post("/update_performance", (req, res) => {

  // Di sini nantinya bisa ditambahkan logika update ke database.

  // Untuk sementara, langsung respons sukses.

  res.json({

    success: true,

    new_learning_style: "reading"

  });

});



// ================== START ==================

app.listen(PORT, () => {

  console.log("✅ Server berjalan di port " + PORT);

});
