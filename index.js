const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// 【核心改變 1：從環境變數讀取 API 金鑰 (保護你的金鑰不被偷)】
const API_KEY = process.env.YOUTUBE_API_KEY;

let currentPollingInterval = null; 

io.on("connection", (socket) => {
  console.log("🟢 有網頁連線了！");

  socket.on("changeVideo", async (videoId) => {
    console.log(`收到切換影片請求，影片 ID: ${videoId}`);

    // 如果沒有設定金鑰，直接報錯
    if (!API_KEY) {
      console.error("❌ 系統錯誤：找不到 YouTube API 金鑰！");
      return;
    }

    // 停止上一部影片的抓取循環
    if (currentPollingInterval) {
      clearInterval(currentPollingInterval);
      currentPollingInterval = null;
      console.log("已停止舊的聊天室抓取");
    }

    try {
      // 步驟一：透過影片 ID，向官方詢問這部影片的「聊天室 ID」
      const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${API_KEY}`;
      const videoRes = await fetch(videoUrl);
      const videoData = await videoRes.json();

      if (!videoData.items || videoData.items.length === 0) {
        console.log("⚠️ 找不到影片，或這不是一部公開影片。");
        return;
      }

      const liveDetails = videoData.items[0].liveStreamingDetails;
      if (!liveDetails || !liveDetails.activeLiveChatId) {
        console.log("⚠️ 這部影片目前沒有開放直播聊天室！");
        return;
      }

      const liveChatId = liveDetails.activeLiveChatId;
      console.log(`✅ 成功取得聊天室 ID: ${liveChatId}，開始抓取...`);

      // 官方 API 會給我們一個「書籤 (pageToken)」，讓我們下次只抓新的留言
      let nextPageToken = ""; 

      // 步驟二：每隔 3 秒，拿著聊天室 ID 和書籤，去抓最新留言
      currentPollingInterval = setInterval(async () => {
        try {
          let chatUrl = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&key=${API_KEY}`;
          if (nextPageToken) {
            chatUrl += `&pageToken=${nextPageToken}`;
          }

          const chatRes = await fetch(chatUrl);
          const chatData = await chatRes.json();

          // 如果有抓到新留言
          if (chatData.items && chatData.items.length > 0) {
            chatData.items.forEach(item => {
              const authorName = item.authorDetails.displayName;
              const message = item.snippet.displayMessage;
              
              // 廣播給前端網頁
              io.emit("chatMessage", { name: authorName, text: message });
            });
          }

          // 更新書籤，準備下一次抓取
          if (chatData.nextPageToken) {
            nextPageToken = chatData.nextPageToken;
          }

        } catch (err) {
          console.error("抓取留言時發生錯誤:", err.message);
        }
      }, 3000); // 3000毫秒 = 3秒

    } catch (error) {
      console.error("❌ 發生預期外錯誤:", error.message);
    }
  });
});

// 讓雲端主機決定 Port
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 伺服器已啟動！正在監聽 Port: ${PORT}`);
});