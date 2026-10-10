SMART MOVE TRANSPORT

Backend : Node.js
Frontend : HTML, CSS,and java script

Relational database : Oracle database for passengers,vehicles, drivers, routes, trips, tickets, maintenance

NoSQL database : MongoDB for (database name : "SmartMoveDB) reviews, announcement, trip media and vehicle documents



Project structure
 server.js = Express server and all API routes
 public    = public pages( home, login pages, styles, images)
 private   = passenger and admin dashboard
 database  = oracle and monogo databases


 Install dependencies = npm install ----> npm start




 .env file required
 PORT : Port the server runs on (default 3000)
 SESSION_SECRET : Any long random string used to sign sessions
 ORACLE_USER : Oracle database username
 ORACLE_PASSWORD : Oracle database password
 ORACLE_CONNECT : Oracle connect string 
 MONGO_URI : MongoDB connection string 
 ADMIN_USER : Admin login username 
 ADMIN_PASS : Admin login password

