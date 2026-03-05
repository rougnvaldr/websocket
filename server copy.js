const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");
const webpush = require("web-push");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const userSocketMap = {};

// ✅ Set your VAPID keys
webpush.setVapidDetails(
  "mailto:tangguanronald@gmail.com",
  "BO1nVVgl9aezZYtBk11dErv52ZPIUv6U0H8z-bnMry9-f7LNrAtFUPdkvqnGvd6h4ebimMv5T9Uy-UV8Igjb6jc",
  "IGV0PfBCFy4LhZ2_0BBAqYLCmGNLgz8qThcyhaMuRxk"
);

// ✅ MySQL config
const dbConfig = {
  host: "srv1410.hstgr.io",
  user: "u484295633_btao",
  password: "Btao_072924",
  database: "u484295633_btao",
};

io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  // ========== CHAT MESSAGE HANDLER ==========
  socket.on("message", async (data) => {
    const { user_id, message } = data;
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");

    let conn;

    try {
      conn = await mysql.createConnection(dbConfig);

      const [userResult] = await conn.execute(
        "SELECT firstname, lastname FROM bs_user WHERE user_id = ?",
        [user_id]
      );

      let fullName = `User ${user_id}`;
      if (userResult.length > 0) {
        const user = userResult[0];
        fullName = `${user.firstname} ${user.lastname}`;
      }

      await conn.execute(
        "INSERT INTO tbl_chat (user_id, message, sent_by, date_time_sent) VALUES (?, ?, ?, ?)",
        [user_id, message, user_id, now]
      );

      io.emit("message", {
        fullname: fullName,
        message,
        sent_by: user_id,
        date_time_sent: now,
      });

      const [subs] = await conn.execute(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id != ?",
        [user_id]
      );

      const payload = JSON.stringify({
        title: fullName,
        body: message,
      });

      for (const sub of subs) {
        const pushConfig = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        };

        try {
          await webpush.sendNotification(pushConfig, payload);
          console.log("✅ Push sent to", sub.endpoint);
        } catch (err) {
          console.error("❌ Push error:", err.message);
          if (err.statusCode === 410 || err.statusCode === 404) {
            await conn.execute(
              "DELETE FROM push_subscriptions WHERE endpoint = ?",
              [sub.endpoint]
            );
            console.log("🧹 Removed expired subscription");
          }
        }
      }
    } catch (err) {
      console.error("❌ DB Error:", err.message);
    } finally {
      if (conn) await conn.end();
    }
  });

  // ========== WEBRTC SIGNALING ==========

  socket.on("register-user", async (data) => {
    const user_id = data.user_id;
    userSocketMap[user_id] = socket.id;

    try {
      const conn = await mysql.createConnection(dbConfig);
      const [users] = await conn.execute(
        "SELECT user_id, firstname, lastname FROM bs_user WHERE user_id != ?",
        [user_id]
      );

      const userList = users.map((user) => ({
        id: user.user_id,
        name: `${user.firstname} ${user.lastname}`,
      }));

      socket.emit("user-list", userList);
      await conn.end();
    } catch (err) {
      console.error("❌ Failed to fetch user list:", err.message);
    }
  });

  socket.on("call-user", (data) => {
    const targetSocketId = userSocketMap[data.to];
    if (targetSocketId) {
      io.to(targetSocketId).emit("call-made", {
        offer: data.offer,
        from: socket.id,
      });
    }
  });

  socket.on("make-answer", (data) => {
    const targetSocketId = userSocketMap[data.to];
    if (targetSocketId) {
      io.to(targetSocketId).emit("answer-made", {
        answer: data.answer,
        from: socket.id,
      });
    }
  });

  socket.on("ice-candidate", (data) => {
    const targetSocketId = userSocketMap[data.to];
    if (targetSocketId) {
      io.to(targetSocketId).emit("ice-candidate", {
        candidate: data.candidate,
        from: socket.id,
      });
    }
  });

  socket.on("disconnect", () => {
    for (const [uid, sid] of Object.entries(userSocketMap)) {
      if (sid === socket.id) {
        delete userSocketMap[uid];
        break;
      }
    }
  });
});

// ✅ Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Chat & WebRTC server running on port ${PORT}`);
});
