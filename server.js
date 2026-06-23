```javascript
require("dotenv").config();
console.log("🚀 SERVER START");

const fetch = require("node-fetch");
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");

const app = express();
const PORT = process.env.PORT || 3000;

// ================== CORS FIX ==================
app.use(cors({
  origin: [
    "https://elearning-ai.infinityfreeapp.com",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
  ],
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
  credentials: true
}));

// penting untuk preflight request
app.options("*", cors());

app.use(express.json());

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

// ================== MIGRASI ==================
async function runMigrations(database) {
  console.log("📦 Menjalankan migrasi...");

  await database.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50),
      email VARCHAR(100),
      password VARCHAR(255),
      learning_style VARCHAR(20) DEFAULT 'reading',
      visual_score FLOAT DEFAULT 0,
      auditory_score FLOAT DEFAULT 0,
      reading_score FLOAT DEFAULT 0,
      kinesthetic_score FLOAT DEFAULT 0
    )
  `);

  await database.execute(`
    CREATE TABLE IF NOT EXISTS classification_rules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      visual_weight FLOAT DEFAULT 1,
      auditory_weight FLOAT DEFAULT 1,
      reading_weight FLOAT DEFAULT 1,
      kinesthetic_weight FLOAT DEFAULT 1
    )
  `);

  const [rules] = await database.execute(
    "SELECT COUNT(*) cnt FROM classification_rules"
  );

  if (rules[0].cnt === 0) {
    await database.execute(`
      INSERT INTO classification_rules
      (visual_weight,auditory_weight,reading_weight,kinesthetic_weight)
      VALUES (1,1,1,1)
    `);
  }

  await database.execute(`
    CREATE TABLE IF NOT EXISTS activities (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(200),
      type ENUM('video','teks','praktik'),
      content_url VARCHAR(500),
      style_target ENUM('visual','auditory','reading','kinesthetic')
    )
  `);

  await database.execute(`
    CREATE TABLE IF NOT EXISTS ai_generated_quizzes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      topic VARCHAR(200),
      num_questions INT,
      questions JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
      database: process.env.DB_NAME,
      ssl: {
        rejectUnauthorized: false
      }
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
app.post("/analyze", async(req,res)=>{

try{

const {answers}=req.body;

if(!answers || answers.length!==8){
return res.status(400).json({
success:false,
message:"Jawaban tidak lengkap"
});
}

const scores={
visual:0,
auditory:0,
reading:0,
kinesthetic:0
};

answers.forEach(a=>{
scores[a]++;
});

const learning_style=
Object.keys(scores)
.reduce((a,b)=>
scores[a]>scores[b]?a:b
);

return res.json({
success:true,
learning_style,
scores,
activities:[]
});

}catch(err){

console.error(err);

res.status(500).json({
success:false,
message:err.message
});

}

});

// ================== GENERATE QUIZ ==================
app.post("/generate-quiz", async(req,res)=>{

try{

if(!process.env.OPENROUTER_API_KEY){

return res.status(500).json({
success:false,
message:"OPENROUTER_API_KEY belum diisi"
});

}

const response=await fetch(
"https://openrouter.ai/api/v1/chat/completions",
{
method:"POST",
headers:{
Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,
"Content-Type":"application/json",

"HTTP-Referer":
"https://backend-nodejs-production-714f.up.railway.app",

"X-Title":
"elearning-ai"
},

body:JSON.stringify({
model:"tencent/hy3-preview:free",
messages:[
{
role:"user",
content:"Buat 3 soal AI dalam JSON"
}
]
})
}
);

const data=await response.json();

res.json(data);

}catch(err){

res.status(500).json({
success:false,
message:err.message
});

}

});

// ================== UPDATE PERFORMANCE ==================
app.post("/update_performance",(req,res)=>{

res.json({
success:true,
new_learning_style:"reading"
});

});

// ================== START ==================
app.listen(PORT,()=>{

console.log(`✅ Server berjalan di port ${PORT}`);

});
```
