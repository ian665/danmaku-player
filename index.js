const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

const API_KEY = process.env.YOUTUBE_API_KEY;

// 【核心修改 1】使用 Map 來儲存「每個影片」專屬的抓取計時器與觀看人數
// 資料結構長這樣: { "影片ID": { intervalId: 計時器, viewers: 觀看人數 } }
const activeStreams = new Map();

io.on("connection", (socket) => {
  console.log(`有新用戶連線了！ID: ${socket.id}`);

  // 紀錄這個連線目前正在看哪個影片，方便他切換或斷線時進行清理
  let currentRoom = null;

  socket.on("changeVideo", async (videoId) => {
    console.log(`用戶 ${socket.id} 請求切換影片: ${videoId}`);

    if (!API_KEY) {
      console.error("系統錯誤：找不到 YouTube API 金鑰！");
      return;
    }

    // 【核心修改 2】如果用戶本來有在看別的影片，先讓他「離開舊房間」並減少觀看人數
    if (currentRoom) {
      socket.leave(currentRoom);
      decrementViewer(currentRoom);
    }

    // 【核心修改 3】讓用戶「加入新房間」
    socket.join(videoId);
    currentRoom = videoId;

    // 【核心修改 4】檢查伺服器是不是「已經在抓」這部影片了？
    // 如果已經有人在看這部影片，就不需要重新啟動計時器，只要觀看人數 +1 即可
    if (activeStreams.has(videoId)) {
      const streamData = activeStreams.get(videoId);
      streamData.viewers++;
      console.log(`影片 ${videoId} 已經在抓取中，目前觀看人數: ${streamData.viewers}`);
      return; 
    }

    // --- 以下是「第一次有人看這部影片」的處理邏輯 ---
    console.log(`影片 ${videoId} 是新的，伺服器開始初始化抓取...`);
    
    // 先在 Map 中登記這部影片，觀看人數設為 1
    activeStreams.set(videoId, { intervalId: null, viewers: 1 });

    try {
      // 步驟一：向官方詢問這部影片的「聊天室 ID」
      const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${API_KEY}`;
      const videoRes = await fetch(videoUrl);
      const videoData = await videoRes.json();

      if (!videoData.items || videoData.items.length === 0) {
        console.log(`找不到影片 ${videoId}，或非公開。`);
        activeStreams.delete(videoId); // 清除紀錄
        return;
      }

      const liveDetails = videoData.items[0].liveStreamingDetails;
      if (!liveDetails || !liveDetails.activeLiveChatId) {
        console.log(`影片 ${videoId} 目前沒有開放直播聊天室！`);
        activeStreams.delete(videoId); // 清除紀錄
        return;
      }

      const liveChatId = liveDetails.activeLiveChatId;
      console.log(`成功取得 ${videoId} 的聊天室 ID: ${liveChatId}，開始輪詢...`);

      let nextPageToken = ""; 

      // 步驟二：啟動專屬這部影片的計時器
      const intervalId = setInterval(async () => {
        try {
          let chatUrl = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&key=${API_KEY}`;
          if (nextPageToken) chatUrl += `&pageToken=${nextPageToken}`;

          const chatRes = await fetch(chatUrl);
          const chatData = await chatRes.json();

          if (chatData.items && chatData.items.length > 0) {
            const totalMessages = chatData.items.length;
            const delayBetweenMessages = 3000 / totalMessages;

            chatData.items.forEach((item, index) => {
              const authorName = item.authorDetails.displayName;
              const message = item.snippet.displayMessage;
              
              setTimeout(() => {
                // 【核心修改 5】把 io.emit 改成 io.to(videoId).emit
                // 只發送彈幕給「有加入這個影片房間」的用戶！
                io.to(videoId).emit("chatMessage", { name: authorName, text: message });
              }, index * delayBetweenMessages);
            });
          }

          if (chatData.nextPageToken) {
            nextPageToken = chatData.nextPageToken;
          }

        } catch (err) {
          console.error(`抓取 ${videoId} 留言時發生錯誤:`, err.message);
        }
      }, 3000);

      // 將啟動的計時器 ID 存回 Map 裡面，方便以後清除
      const streamData = activeStreams.get(videoId);
      if (streamData) {
        streamData.intervalId = intervalId;
      } else {
        // 防呆機制：如果在等 API 回應的期間，那唯一一個觀眾剛好關掉網頁了
        clearInterval(intervalId);
      }

    } catch (error) {
      console.error("發生預期外錯誤:", error.message);
      activeStreams.delete(videoId);
    }
  });

  // 【核心修改 6】處理用戶關閉網頁 (斷線)
  socket.on("disconnect", () => {
    console.log(`用戶斷線: ${socket.id}`);
    if (currentRoom) {
      decrementViewer(currentRoom);
    }
  });

  // 負責減少觀看人數的輔助函式 (沒人看時自動停用資源)
  function decrementViewer(videoId) {
    if (activeStreams.has(videoId)) {
      const streamData = activeStreams.get(videoId);
      streamData.viewers--;
      
      console.log(`影片 ${videoId} 觀看人數減少為: ${streamData.viewers}`);
      
      // 如果這部影片已經沒人在看了，就砍掉計時器，節省 YouTube API 配額與伺服器效能
      if (streamData.viewers <= 0) {
        console.log(`影片 ${videoId} 已經沒人看了，停止抓取聊天室並釋放資源。`);
        clearInterval(streamData.intervalId);
        activeStreams.delete(videoId);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`伺服器已啟動！正在監聽 Port: ${PORT}`);
});