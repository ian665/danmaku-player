const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { LiveChat } = require("youtube-chat");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

let liveChatInstance = null; 
// 新增一個變數，用來記錄「開始抓取的時間點」
let connectionTime = 0; 

io.on("connection", (socket) => {
  console.log("🟢 有網頁連線了！");

  socket.on("changeVideo", async (videoId) => {
    console.log(`收到切換影片請求，影片 ID: ${videoId}`);

    if (liveChatInstance) {
      liveChatInstance.stop();
      liveChatInstance = null;
      console.log("已停止舊的聊天室抓取");
    }

    // 記錄當下時間
    connectionTime = Date.now();
    
    liveChatInstance = new LiveChat({ liveId: videoId });

    liveChatInstance.on("start", (liveId) => {
      console.log(`✅ 成功開始抓取 YouTube 留言！直播 ID: ${liveId}`);
    });

    liveChatInstance.on("chat", (chatItem) => {
      // 【核心解法】如果收到留言的時間，距離剛連線不到 3 秒 (3000毫秒)，就當作歷史留言丟棄！
      if (Date.now() - connectionTime < 3000) {
        return; 
      }

      const authorName = chatItem.author.name;
      const message = chatItem.message.map((item) => item.text || item.emojiText).join("");
      
      io.emit("chatMessage", { name: authorName, text: message });
    });

    liveChatInstance.on("error", (err) => {
      console.error("❌ 抓取錯誤:", err.message);
    });

    const ok = await liveChatInstance.start();
    if (!ok) {
      console.log("⚠️ 無法啟動，請確認該影片是否為「公開的直播中」影片。");
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 伺服器已啟動！正在監聽 Port: ${PORT}`);
});