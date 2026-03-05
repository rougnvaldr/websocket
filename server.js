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

// Store both socket ID and user info
const userSocketMap = {}; // user_id -> socket_id
const socketUserMap = {}; // socket_id -> user_info
const activeUsers = new Map(); // user_id -> {socket_id, name, status}

// ✅ VAPID keys for web push
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

// Helper function to broadcast user list to all connected users
function broadcastUserList() {
  const userList = Array.from(activeUsers.values()).map(user => ({
    id: user.user_id,
    name: user.name,
    status: user.status
  }));
  
  io.emit("user-list", userList);
}

io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  // ✅ Handle user registration and fetch contact list
  socket.on("register-user", async (data) => {
    const { user_id } = data;
    
    // Remove user from previous socket if exists
    if (userSocketMap[user_id]) {
      const oldSocketId = userSocketMap[user_id];
      delete socketUserMap[oldSocketId];
      activeUsers.delete(user_id);
    }

    // Register new socket
    userSocketMap[user_id] = socket.id;
    socketUserMap[socket.id] = { user_id };

    try {
      const conn = await mysql.createConnection(dbConfig);
      
      // Get current user info
      const [currentUser] = await conn.execute(
        "SELECT user_id, firstname, lastname FROM bs_user WHERE user_id = ?",
        [user_id]
      );

      if (currentUser.length > 0) {
        const userName = `${currentUser[0].firstname} ${currentUser[0].lastname}`;
        
        // Add to active users
        activeUsers.set(user_id, {
          user_id: user_id,
          socket_id: socket.id,
          name: userName,
          status: 'online'
        });

        // Update socket user map
        socketUserMap[socket.id] = {
          user_id: user_id,
          name: userName
        };
      }

      // Get all users for the dropdown
      const [allUsers] = await conn.execute(
        "SELECT user_id, firstname, lastname FROM bs_user WHERE user_id != ?",
        [user_id]
      );

      const userList = allUsers.map((user) => ({
        id: user.user_id,
        name: `${user.firstname} ${user.lastname}`,
        online: activeUsers.has(user.user_id)
      }));

      // Send user list to the requesting user
      socket.emit("user-list", userList);
      
      // Broadcast updated user list to all users
      broadcastUserList();
      
      await conn.end();
      console.log(`✅ User registered: ${user_id} (${socketUserMap[socket.id]?.name})`);
    } catch (err) {
      console.error("❌ Failed to register user:", err.message);
    }
  });

  // ✅ Handle chat message
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

      const fullName = userResult.length
        ? `${userResult[0].firstname} ${userResult[0].lastname}`
        : `User ${user_id}`;

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

      // Push notifications for offline users
      const [subs] = await conn.execute(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id != ?",
        [user_id]
      );

      const payload = JSON.stringify({ title: fullName, body: message });

      for (const sub of subs) {
        const pushConfig = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        };
        try {
          await webpush.sendNotification(pushConfig, payload);
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", [sub.endpoint]);
          }
        }
      }
    } catch (err) {
      console.error("❌ DB Error:", err.message);
    } finally {
      if (conn) await conn.end();
    }
  });

  // ✅ WebRTC Signaling for Audio/Video Call
  socket.on("call-user", (data) => {
    const targetSocketId = userSocketMap[data.to];
    const callerInfo = socketUserMap[socket.id];
    
    if (targetSocketId && callerInfo) {
      console.log(`📞 Call initiated: ${callerInfo.name} -> User ${data.to}`);
      
      io.to(targetSocketId).emit("call-made", {
        offer: data.offer,
        from: socket.id,
        fromUserId: callerInfo.user_id,
        callerName: callerInfo.name,
        callType: data.callType || "audio",
      });
    } else {
      // User is offline or not found
      socket.emit("call-failed", {
        reason: "User is not available",
        targetUserId: data.to
      });
    }
  });

  socket.on("make-answer", (data) => {
    const targetSocketId = data.to; // This should be the socket ID
    if (targetSocketId) {
      console.log(`✅ Call answered: ${socket.id} -> ${targetSocketId}`);
      
      io.to(targetSocketId).emit("answer-made", {
        answer: data.answer,
        from: socket.id,
      });
    }
  });

  socket.on("ice-candidate", (data) => {
    const targetSocketId = data.to; // This should be the socket ID
    if (targetSocketId) {
      io.to(targetSocketId).emit("ice-candidate", {
        candidate: data.candidate,
        from: socket.id,
      });
    }
  });

  // ✅ Handle call declined
  socket.on("call-declined", (data) => {
    const targetSocketId = data.to; // This should be the socket ID
    if (targetSocketId) {
      console.log(`❌ Call declined: ${socket.id} declined ${targetSocketId}`);
      
      io.to(targetSocketId).emit("call-declined", {
        from: socket.id,
      });
    }
  });

  // ✅ Handle call ended
  socket.on("call-ended", (data) => {
    const targetSocketId = data.to;
    if (targetSocketId) {
      console.log(`📴 Call ended: ${socket.id} -> ${targetSocketId}`);
      
      io.to(targetSocketId).emit("call-ended", {
        from: socket.id,
      });
    }
  });

  // ✅ On disconnect
  socket.on("disconnect", () => {
    const userInfo = socketUserMap[socket.id];
    
    if (userInfo) {
      const { user_id, name } = userInfo;
      
      // Clean up mappings
      delete userSocketMap[user_id];
      delete socketUserMap[socket.id];
      activeUsers.delete(user_id);
      
      console.log(`❌ User disconnected: ${name} (${socket.id})`);
      
      // Broadcast updated user list
      broadcastUserList();
    } else {
      console.log("❌ Unknown user disconnected:", socket.id);
    }
  });

  // ✅ Handle ping/pong for connection health
  socket.on("ping", () => {
    socket.emit("pong");
  });
});

// ✅ Error handling
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
});

// ✅ Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Chat & WebRTC server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`);
});