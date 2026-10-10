require('dotenv').config();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const oracledb = require('oracledb');
const { MongoClient } = require('mongodb');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));
app.use(express.static('public'));

let mongoDb;

// Oracle query 
async function run(sql, binds = {}) {
  const conn = await oracledb.getConnection();
  try {
    return await conn.execute(sql, binds, { autoCommit: true });
  } finally {
    await conn.close();
  }
}

// Login  = admin or passenger
function need(role, isPage) {
  return (req, res, next) => {
    if (req.session.role === role) return next();
    if (isPage) return res.redirect('/' + role + '-login.html');
    res.status(401).json({ error: 'Please login first' });
  };
}

// ---------- Protected pages ----------
app.get('/admin.html', need('admin', true), (req, res) =>
  res.sendFile(path.join(__dirname, 'private', 'admin.html')));

app.get('/passenger.html', need('passenger', true), (req, res) =>
  res.sendFile(path.join(__dirname, 'private', 'passenger.html')));
app.get(/^\/passenger-([a-z]+)\.html$/, need('passenger', true), (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'passenger-' + req.params[0] + '.html'),
    err => { if (err) res.status(404).send('Page not found'); });
});




// ---------- Passenger register ----------
app.post('/api/passenger/register', async (req, res) => {
  const { firstName, lastName, email, phone, address, password } = req.body;
  if (!firstName || !lastName || !email || !password || password.length < 6)
    return res.status(400).json({ error: 'Fill all required fields (password min 6 characters)' });
  try {
    const next = await run(
      `SELECT NVL(MAX(TO_NUMBER(SUBSTR(PASSENGER_ID,2))),0)+1 AS N FROM PASSENGER`);
    const id = 'P' + String(next.rows[0].N).padStart(3, '0');
    const hash = await bcrypt.hash(password, 10);
    await run(
      `INSERT INTO PASSENGER (PASSENGER_ID,FIRST_NAME,LAST_NAME,EMAIL,PHONE,ADDRESS,PASSWORD)
       VALUES (:id,:fn,:ln,:em,:ph,:ad,:pw)`,
      { id, fn: firstName, ln: lastName, em: email.toLowerCase(),
        ph: phone || null, ad: address || null, pw: hash });
    res.json({ ok: true, message: 'Account created! Please login.' });
  } catch (e) {
    if (String(e.message).includes('ORA-00001'))
      return res.status(409).json({ error: 'This email is already registered' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Passenger login ----------
app.post('/api/passenger/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await run(
      `SELECT PASSENGER_ID, FIRST_NAME, PASSWORD FROM PASSENGER WHERE LOWER(EMAIL) = :em`,
      { em: (email || '').toLowerCase() });
    const p = r.rows[0];
    if (!p || !p.PASSWORD || !(await bcrypt.compare(password || '', p.PASSWORD)))
      return res.status(401).json({ error: 'Invalid email or password' });
    req.session.role = 'passenger';
    req.session.userId = p.PASSENGER_ID;
    req.session.name = p.FIRST_NAME;
    res.json({ ok: true, redirect: '/passenger.html' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', (req, res) =>
  res.json({ role: req.session.role || null, name: req.session.name || null }));


// ---------- Passenger dashboard data ----------
app.get('/api/trips', need('passenger'), async (req, res) => {
  try {
    const r = await run(`SELECT t.TRIP_ID, r.ROUTE_NAME,
        TO_CHAR(t.TRIP_DATE,'YYYY-MM-DD') AS TRIP_DATE, t.DEPARTURE_TIME, t.PRICE, v.VEHICLE_TYPE,
        CASE v.VEHICLE_TYPE WHEN 'Three-Wheeler' THEN '/images/three_wheeler.svg'
             WHEN 'Van' THEN '/images/van.svg' WHEN 'Bus' THEN '/images/bus.svg' ELSE '/images/car.svg' END AS PHOTO,
        v.CAPACITY - (SELECT COUNT(*) FROM TICKET k WHERE k.TRIP_ID = t.TRIP_ID AND k.STATUS <> 'Cancelled') AS SEATS_LEFT
      FROM TRIP t
      JOIN ROUTE r ON r.ROUTE_ID = t.ROUTE_ID
      JOIN VEHICLE v ON v.VEHICLE_ID = t.VEHICLE_ID
      WHERE t.STATUS = 'Scheduled' AND t.TRIP_DATE >= TRUNC(SYSDATE)
      ORDER BY t.TRIP_DATE, t.DEPARTURE_TIME`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/announcements', async (req, res) => {
  const list = await mongoDb.collection('announcements')
    .find({ status: 'ACTIVE' }).sort({ date: -1 }).toArray();
  res.json(list);
});


// ---------- Admin login ----------
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    req.session.role = 'admin';
    req.session.name = 'Admin';
    return res.json({ ok: true, redirect: '/admin.html' });
  }
  res.status(401).json({ error: 'Invalid admin username or password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- Admin dashboard data ----------
app.get('/api/admin/stats', need('admin'), async (req, res) => {
  try {
    const r = await run(`SELECT
      (SELECT COUNT(*) FROM VEHICLE) AS VEHICLES,
      (SELECT COUNT(*) FROM DRIVER) AS DRIVERS,
      (SELECT COUNT(*) FROM TRIP) AS TRIPS,
      (SELECT NVL(SUM(AMOUNT),0) FROM PAYMENT WHERE PAYMENT_STATUS='Paid') AS REVENUE
      FROM DUAL`);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Connection test route 
app.get('/api/test', async (req, res) => {
  try {
    const o = await run('SELECT COUNT(*) AS N FROM VEHICLE');
    const m = await mongoDb.collection('announcements').countDocuments();
    res.json({ oracleVehicles: o.rows[0].N, mongoAnnouncements: m });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Admin pages ----------
app.get(/^\/admin-([a-z]+)\.html$/, need('admin', true), (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'admin-' + req.params[0] + '.html'),
    err => { if (err) res.status(404).send('Page not found'); });
});


// ---------- Vehicles API ----------
app.get('/api/admin/vehicles', need('admin'), async (req, res) => {
  try {
    const r = await run(`SELECT VEHICLE_ID, VEHICLE_NUMBER, VEHICLE_TYPE, MODEL, CAPACITY, STATUS
                         FROM VEHICLE ORDER BY VEHICLE_ID`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/vehicles', need('admin'), async (req, res) => {
  const { vehicleNumber, type, model, capacity, status } = req.body;
  if (!vehicleNumber || !type || !model || !(Number(capacity) > 0))
    return res.status(400).json({ error: 'Fill all fields (capacity must be more than 0)' });
  try {
    const n = await run(`SELECT NVL(MAX(TO_NUMBER(SUBSTR(VEHICLE_ID,2))),0)+1 AS N FROM VEHICLE`);
    const id = 'V' + String(n.rows[0].N).padStart(3, '0');
    await run(`INSERT INTO VEHICLE (VEHICLE_ID,VEHICLE_NUMBER,VEHICLE_TYPE,MODEL,CAPACITY,STATUS)
               VALUES (:id,:num,:vt,:model,:cap,:st)`,
      { id, num: vehicleNumber, vt: type, model, cap: Number(capacity), st: status || 'Available' });
    res.json({ ok: true, message: 'Vehicle ' + id + ' added' });
  } catch (e) {
    if (String(e.message).includes('ORA-00001'))
      return res.status(409).json({ error: 'This vehicle number already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/vehicles/:id', need('admin'), async (req, res) => {
  const { vehicleNumber, type, model, capacity, status } = req.body;
 if (!vehicleNumber || !type || !model || !status || !(Number(capacity) > 0))
    return res.status(400).json({ error: 'Fill all fields (capacity must be more than 0)' });
  try {
    const r = await run(`UPDATE VEHICLE SET VEHICLE_NUMBER=:num, VEHICLE_TYPE=:vt, MODEL=:model,
                         CAPACITY=:cap, STATUS=:st WHERE VEHICLE_ID=:id`,
      { num: vehicleNumber, vt: type, model, cap: Number(capacity), st: status, id: req.params.id });
    if (r.rowsAffected === 0) return res.status(404).json({ error: 'Vehicle not found' });
    res.json({ ok: true, message: 'Vehicle updated' });
  } catch (e) {
    if (String(e.message).includes('ORA-00001'))
      return res.status(409).json({ error: 'This vehicle number already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/vehicles/:id', need('admin'), async (req, res) => {
  try {
    const r = await run(`DELETE FROM VEHICLE WHERE VEHICLE_ID=:id`, { id: req.params.id });
    if (r.rowsAffected === 0) return res.status(404).json({ error: 'Vehicle not found' });
    res.json({ ok: true, message: 'Vehicle deleted' });
  } catch (e) {
    if (String(e.message).includes('ORA-02292'))
      return res.status(409).json({ error: 'Cannot delete: this vehicle is used in trips or maintenance records' });
    res.status(500).json({ error: e.message });
  }
});



// ---------- Drivers API ----------
function driverError(b) {
  if (!b.firstName || !b.lastName || !b.license || !b.phone || !b.status) return 'Fill all required fields';
  if (!/^\d{10}$/.test(b.phone)) return 'Phone must be 10 digits';
  if (b.email && !/^\S+@\S+\.\S+$/.test(b.email)) return 'Email is not valid';
  return null;
}

app.get('/api/admin/drivers', need('admin'), async (req, res) => {
  try {
    const r = await run(`SELECT DRIVER_ID, FIRST_NAME, LAST_NAME, LICENSE_NUMBER, PHONE, EMAIL, STATUS
                         FROM DRIVER ORDER BY DRIVER_ID`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/drivers', need('admin'), async (req, res) => {
  const b = req.body;
  const bad = driverError(b);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const n = await run(`SELECT NVL(MAX(TO_NUMBER(SUBSTR(DRIVER_ID,2))),0)+1 AS N FROM DRIVER`);
    const id = 'D' + String(n.rows[0].N).padStart(3, '0');
    await run(`INSERT INTO DRIVER (DRIVER_ID,FIRST_NAME,LAST_NAME,LICENSE_NUMBER,PHONE,EMAIL,STATUS)
               VALUES (:id,:fn,:ln,:lic,:ph,:em,:st)`,
      { id, fn: b.firstName, ln: b.lastName, lic: b.license, ph: b.phone, em: b.email || null, st: b.status });
    res.json({ ok: true, message: 'Driver ' + id + ' added' });
  } catch (e) {
    if (String(e.message).includes('ORA-00001'))
      return res.status(409).json({ error: 'This license number already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/drivers/:id', need('admin'), async (req, res) => {
  const b = req.body;
  const bad = driverError(b);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const r = await run(`UPDATE DRIVER SET FIRST_NAME=:fn, LAST_NAME=:ln, LICENSE_NUMBER=:lic,
                         PHONE=:ph, EMAIL=:em, STATUS=:st WHERE DRIVER_ID=:id`,
      { fn: b.firstName, ln: b.lastName, lic: b.license, ph: b.phone, em: b.email || null, st: b.status, id: req.params.id });
    if (r.rowsAffected === 0) return res.status(404).json({ error: 'Driver not found' });
    res.json({ ok: true, message: 'Driver updated' });
  } catch (e) {
    if (String(e.message).includes('ORA-00001'))
      return res.status(409).json({ error: 'This license number already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/drivers/:id', need('admin'), async (req, res) => {
  try {
    const r = await run(`DELETE FROM DRIVER WHERE DRIVER_ID=:id`, { id: req.params.id });
    if (r.rowsAffected === 0) return res.status(404).json({ error: 'Driver not found' });
    res.json({ ok: true, message: 'Driver deleted' });
  } catch (e) {
    if (String(e.message).includes('ORA-02292'))
      return res.status(409).json({ error: 'Cannot delete: this driver is assigned to trips' });
    res.status(500).json({ error: e.message });
  }
});


// ---------- Routes API ----------
function routeError(b) {
  if (!b.start || !b.end || !(Number(b.distance) > 0)) return 'Fill all fields (distance must be more than 0)';
  if (b.start.trim().toLowerCase() === b.end.trim().toLowerCase()) return 'Start and End locations must be different';
  return null;
}

app.get('/api/admin/routes', need('admin'), async (req, res) => {
  try {
    const r = await run(`SELECT ROUTE_ID, ROUTE_NAME, START_LOCATION, END_LOCATION, DISTANCE
                         FROM ROUTE ORDER BY ROUTE_ID`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/routes', need('admin'), async (req, res) => {
  const b = req.body;
  const bad = routeError(b);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const n = await run(`SELECT NVL(MAX(TO_NUMBER(SUBSTR(ROUTE_ID,2))),0)+1 AS N FROM ROUTE`);
    const id = 'R' + String(n.rows[0].N).padStart(3, '0');
    const name = b.start.trim() + ' - ' + b.end.trim();
    await run(`INSERT INTO ROUTE (ROUTE_ID,ROUTE_NAME,START_LOCATION,END_LOCATION,DISTANCE)
               VALUES (:id,:name,:s,:e,:d)`,
      { id, name, s: b.start.trim(), e: b.end.trim(), d: Number(b.distance) });
    res.json({ ok: true, message: 'Route ' + id + ' added' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/routes/:id', need('admin'), async (req, res) => {
  const b = req.body;
  const bad = routeError(b);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const name = b.start.trim() + ' - ' + b.end.trim();
    const r = await run(`UPDATE ROUTE SET ROUTE_NAME=:name, START_LOCATION=:s, END_LOCATION=:e, DISTANCE=:d
                         WHERE ROUTE_ID=:id`,
      { name, s: b.start.trim(), e: b.end.trim(), d: Number(b.distance), id: req.params.id });
    if (r.rowsAffected === 0) return res.status(404).json({ error: 'Route not found' });
    res.json({ ok: true, message: 'Route updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/routes/:id', need('admin'), async (req, res) => {
  try {
    const r = await run(`DELETE FROM ROUTE WHERE ROUTE_ID=:id`, { id: req.params.id });
    if (r.rowsAffected === 0) return res.status(404).json({ error: 'Route not found' });
    res.json({ ok: true, message: 'Route deleted' });
  } catch (e) {
    if (String(e.message).includes('ORA-02292'))
      return res.status(409).json({ error: 'Cannot delete: this route is used in trips' });
    res.status(500).json({ error: e.message });
  }
});

// ---------- Trips API ----------
function tripError(b) {
  if (!b.vehicleId || !b.driverId || !b.routeId || !b.date || !b.departure || !b.arrival || !b.status || !(Number(b.price) > 0))
    return 'Fill all fields (price must be more than 0)';
  if (b.arrival <= b.departure) return 'Arrival time must be after departure time';
  return null;
}


async function tripConflict(b, excludeId) {
  if (b.status === 'Cancelled') return null;
  const r = await run(
    `SELECT TRIP_ID, VEHICLE_ID FROM TRIP
     WHERE TRIP_DATE = TO_DATE(:d,'YYYY-MM-DD') AND STATUS <> 'Cancelled' AND TRIP_ID <> :ex
       AND (VEHICLE_ID = :v OR DRIVER_ID = :dr)
       AND DEPARTURE_TIME < :arr AND ARRIVAL_TIME > :dep`,
    { d: b.date, ex: excludeId, v: b.vehicleId, dr: b.driverId, arr: b.arrival, dep: b.departure });
  if (r.rows.length) {
    const t = r.rows[0];
    return (t.VEHICLE_ID === b.vehicleId ? 'This vehicle' : 'This driver') +
           ' is already assigned to trip ' + t.TRIP_ID + ' at that time';
  }
  return null;
}

app.get('/api/admin/trips', need('admin'), async (req, res) => {
  try {
    const r = await run(`SELECT t.TRIP_ID, t.VEHICLE_ID, t.DRIVER_ID, t.ROUTE_ID,
        TO_CHAR(t.TRIP_DATE,'YYYY-MM-DD') AS TRIP_DATE, t.DEPARTURE_TIME, t.ARRIVAL_TIME, t.STATUS, t.PRICE,
        r.ROUTE_NAME, v.VEHICLE_NUMBER, d.FIRST_NAME || ' ' || d.LAST_NAME AS DRIVER_NAME
      FROM TRIP t
      JOIN ROUTE r ON r.ROUTE_ID = t.ROUTE_ID
      JOIN VEHICLE v ON v.VEHICLE_ID = t.VEHICLE_ID
      JOIN DRIVER d ON d.DRIVER_ID = t.DRIVER_ID
      ORDER BY t.TRIP_DATE DESC, t.TRIP_ID DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/trips', need('admin'), async (req, res) => {
  const b = req.body;
  const bad = tripError(b);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const conflict = await tripConflict(b, '-');
    if (conflict) return res.status(409).json({ error: conflict });
    const n = await run(`SELECT NVL(MAX(TO_NUMBER(SUBSTR(TRIP_ID,2))),0)+1 AS N FROM TRIP`);
    const id = 'T' + String(n.rows[0].N).padStart(3, '0');
    await run(`INSERT INTO TRIP (TRIP_ID,VEHICLE_ID,DRIVER_ID,ROUTE_ID,TRIP_DATE,DEPARTURE_TIME,ARRIVAL_TIME,STATUS,PRICE)
               VALUES (:id,:v,:dr,:r,TO_DATE(:d,'YYYY-MM-DD'),:dep,:arr,:st,:p)`,
      { id, v: b.vehicleId, dr: b.driverId, r: b.routeId, d: b.date, dep: b.departure, arr: b.arrival, st: b.status, p: Number(b.price) });
    res.json({ ok: true, message: 'Trip ' + id + ' scheduled' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/trips/:id', need('admin'), async (req, res) => {
  const b = req.body;
  const bad = tripError(b);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const conflict = await tripConflict(b, req.params.id);
    if (conflict) return res.status(409).json({ error: conflict });
    const r = await run(`UPDATE TRIP SET VEHICLE_ID=:v, DRIVER_ID=:dr, ROUTE_ID=:r, TRIP_DATE=TO_DATE(:d,'YYYY-MM-DD'),
                         DEPARTURE_TIME=:dep, ARRIVAL_TIME=:arr, STATUS=:st, PRICE=:p WHERE TRIP_ID=:id`,
      { v: b.vehicleId, dr: b.driverId, r: b.routeId, d: b.date, dep: b.departure, arr: b.arrival, st: b.status, p: Number(b.price), id: req.params.id });
    if (r.rowsAffected === 0) return res.status(404).json({ error: 'Trip not found' });
    res.json({ ok: true, message: 'Trip updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/trips/:id', need('admin'), async (req, res) => {
  try {
    const r = await run(`DELETE FROM TRIP WHERE TRIP_ID=:id`, { id: req.params.id });
    if (r.rowsAffected === 0) return res.status(404).json({ error: 'Trip not found' });
    res.json({ ok: true, message: 'Trip deleted' });
  } catch (e) {
    if (String(e.message).includes('ORA-02292'))
      return res.status(409).json({ error: 'Cannot delete: this trip has tickets or feedback. Set its status to Cancelled instead' });
    res.status(500).json({ error: e.message });
  }
});


// ---------- Maintenance API ----------
function maintError(b) {
  if (!b.vehicleId || !b.date || !b.type || !b.description || !b.status || b.cost === '' || b.cost == null)
    return 'Fill all fields';
  if (!(Number(b.cost) >= 0)) return 'Cost cannot be negative';
  const today = new Date().toISOString().slice(0, 10);
  if (b.status === 'Completed' && b.date > today) return 'A future service cannot be marked Completed';
  return null;
}

app.get('/api/admin/maintenance', need('admin'), async (req, res) => {
  try {
    const r = await run(`SELECT m.MAINTENANCE_ID, m.VEHICLE_ID, v.VEHICLE_NUMBER,
        TO_CHAR(m.MAINTENANCE_DATE,'YYYY-MM-DD') AS MDATE, m.MAINTENANCE_TYPE, m.DESCRIPTION, m.COST, m.STATUS
      FROM MAINTENANCE m JOIN VEHICLE v ON v.VEHICLE_ID = m.VEHICLE_ID
      ORDER BY m.MAINTENANCE_DATE DESC, m.MAINTENANCE_ID DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/maintenance', need('admin'), async (req, res) => {
  const b = req.body;
  const bad = maintError(b);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const n = await run(`SELECT NVL(MAX(TO_NUMBER(SUBSTR(MAINTENANCE_ID,2))),0)+1 AS N FROM MAINTENANCE`);
    const id = 'M' + String(n.rows[0].N).padStart(3, '0');
    await run(`INSERT INTO MAINTENANCE (MAINTENANCE_ID,VEHICLE_ID,MAINTENANCE_DATE,MAINTENANCE_TYPE,DESCRIPTION,COST,STATUS)
               VALUES (:id,:v,TO_DATE(:d,'YYYY-MM-DD'),:t,:ds,:c,:st)`,
      { id, v: b.vehicleId, d: b.date, t: b.type, ds: b.description, c: Number(b.cost), st: b.status });
    res.json({ ok: true, message: 'Maintenance ' + id + ' added' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/maintenance/:id', need('admin'), async (req, res) => {
  const b = req.body;
  const bad = maintError(b);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const r = await run(`UPDATE MAINTENANCE SET VEHICLE_ID=:v, MAINTENANCE_DATE=TO_DATE(:d,'YYYY-MM-DD'),
        MAINTENANCE_TYPE=:t, DESCRIPTION=:ds, COST=:c, STATUS=:st WHERE MAINTENANCE_ID=:id`,
      { v: b.vehicleId, d: b.date, t: b.type, ds: b.description, c: Number(b.cost), st: b.status, id: req.params.id });
    if (r.rowsAffected === 0) return res.status(404).json({ error: 'Record not found' });
    res.json({ ok: true, message: 'Maintenance updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/maintenance/:id', need('admin'), async (req, res) => {
  try {
    const r = await run(`DELETE FROM MAINTENANCE WHERE MAINTENANCE_ID=:id`, { id: req.params.id });
    if (r.rowsAffected === 0) return res.status(404).json({ error: 'Record not found' });
    res.json({ ok: true, message: 'Maintenance deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ---------- Tickets & Payments API ----------
app.get('/api/admin/tickets', need('admin'), async (req, res) => {
  try {
    const r = await run(`SELECT tk.TICKET_ID, tk.TRIP_ID, tk.SEAT_NUMBER, tk.TICKET_PRICE, tk.STATUS AS TICKET_STATUS,
        TO_CHAR(tk.BOOKING_DATE,'YYYY-MM-DD') AS BOOKING_DATE,
        p.FIRST_NAME || ' ' || p.LAST_NAME AS PASSENGER_NAME, rt.ROUTE_NAME,
        TO_CHAR(t.TRIP_DATE,'YYYY-MM-DD') AS TRIP_DATE,
        pm.PAYMENT_ID, pm.PAYMENT_METHOD, pm.PAYMENT_STATUS
      FROM TICKET tk
      JOIN PASSENGER p ON p.PASSENGER_ID = tk.PASSENGER_ID
      JOIN TRIP t ON t.TRIP_ID = tk.TRIP_ID
      JOIN ROUTE rt ON rt.ROUTE_ID = t.ROUTE_ID
      LEFT JOIN PAYMENT pm ON pm.TICKET_ID = tk.TICKET_ID
      ORDER BY tk.TICKET_ID DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/tickets/:id/pay', need('admin'), async (req, res) => {
  const method = req.body.method;
  if (!['Cash', 'Card', 'Online'].includes(method))
    return res.status(400).json({ error: 'Choose a payment method' });
  try {
    const t = await run(`SELECT STATUS FROM TICKET WHERE TICKET_ID=:id`, { id: req.params.id });
    if (!t.rows.length) return res.status(404).json({ error: 'Ticket not found' });
    if (t.rows[0].STATUS === 'Cancelled') return res.status(409).json({ error: 'A cancelled ticket cannot be paid' });
    const r = await run(`UPDATE PAYMENT SET PAYMENT_STATUS='Paid', PAYMENT_METHOD=:m, PAYMENT_DATE=SYSDATE
                         WHERE TICKET_ID=:id AND PAYMENT_STATUS='Pending'`, { m: method, id: req.params.id });
    if (r.rowsAffected === 0) return res.status(409).json({ error: 'No pending payment for this ticket' });
    res.json({ ok: true, message: 'Payment marked as Paid (' + method + ')' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/tickets/:id/cancel', need('admin'), async (req, res) => {
  let conn;
  try {
    conn = await oracledb.getConnection();
    const t = await conn.execute(`SELECT STATUS FROM TICKET WHERE TICKET_ID=:id`, { id: req.params.id });
    if (!t.rows.length) return res.status(404).json({ error: 'Ticket not found' });
    if (t.rows[0].STATUS === 'Cancelled') return res.status(409).json({ error: 'Ticket is already cancelled' });
    await conn.execute(`UPDATE TICKET SET STATUS='Cancelled' WHERE TICKET_ID=:id`, { id: req.params.id });
    await conn.execute(`UPDATE PAYMENT SET PAYMENT_STATUS = CASE PAYMENT_STATUS WHEN 'Paid' THEN 'Refunded' ELSE 'Cancelled' END
                        WHERE TICKET_ID=:id`, { id: req.params.id });
    await conn.commit();
    res.json({ ok: true, message: 'Ticket cancelled' });
  } catch (e) {
    if (conn) await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    if (conn) await conn.close();
  }
});


// ---------- Reports API  ----------
function fmtVal(v) {
  if (v instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  return v;
}

async function runReport(call, binds = {}) {
  const conn = await oracledb.getConnection();
  try {
    const r = await conn.execute(`BEGIN ${call}; END;`,
      { ...binds, cur: { type: oracledb.CURSOR, dir: oracledb.BIND_OUT } });
    const rs = r.outBinds.cur;
    const rows = await rs.getRows(1000);
    await rs.close();
    return rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, fmtVal(v)])));
  } finally {
    await conn.close();
  }
}

app.get('/api/admin/reports/:name', need('admin'), async (req, res) => {
  const q = req.query;
  try {
    let rows;
    switch (req.params.name) {
      case 'popular-routes':
        rows = await runReport('sp_rpt_popular_routes(:cur)');
        break;
      case 'revenue':
        if (!q.from || !q.to) return res.status(400).json({ error: 'Choose both From and To dates' });
        rows = await runReport('sp_rpt_revenue(:f,:t,:cur)', {
          f: { val: new Date(q.from + 'T00:00:00'), type: oracledb.DATE },
          t: { val: new Date(q.to + 'T23:59:59'), type: oracledb.DATE }
        });
        break;
      case 'passenger-history':
        rows = await runReport('sp_rpt_passenger_history(:p,:cur)', {
          p: { val: q.passenger ? q.passenger.trim().toUpperCase() : null, type: oracledb.STRING }
        });
        break;
      case 'maintenance-due':
        rows = await runReport('sp_rpt_maintenance_due(:m,:cur)', {
          m: { val: Number(q.months), type: oracledb.NUMBER }
        });
        break;
      case 'driver-performance':
        rows = await runReport('sp_rpt_driver_performance(:cur)');
        break;
      default:
        return res.status(404).json({ error: 'Unknown report' });
    }
    res.json(rows);
  } catch (e) {
    const m = /ORA-200\d\d: ([^\n]*)/.exec(e.message);   // our own RAISE_APPLICATION_ERROR messages
    if (m) return res.status(400).json({ error: m[1] });
    res.status(500).json({ error: e.message });
  }
});



// ---------- Passenger booking ----------
app.get('/api/trips/:id/seats', need('passenger'), async (req, res) => {
  try {
    const c = await run(`SELECT v.CAPACITY FROM TRIP t JOIN VEHICLE v ON v.VEHICLE_ID = t.VEHICLE_ID
                         WHERE t.TRIP_ID = :id`, { id: req.params.id });
    if (!c.rows.length) return res.status(404).json({ error: 'Trip not found' });
    const s = await run(`SELECT SEAT_NUMBER FROM TICKET WHERE TRIP_ID = :id AND STATUS <> 'Cancelled'`,
      { id: req.params.id });
    res.json({ capacity: c.rows[0].CAPACITY, taken: s.rows.map(x => x.SEAT_NUMBER) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/passenger/book', need('passenger'), async (req, res) => {
  const { tripId, seats } = req.body;
  const seatList = Array.isArray(seats) ? seats : (req.body.seat ? [req.body.seat] : []);
  if (!tripId || !seatList.length) return res.status(400).json({ error: 'Choose at least one seat' });

  const booked = [], failed = [];
  for (const seat of seatList) {
    let conn;
    try {
      conn = await oracledb.getConnection();
      const r = await conn.execute(`BEGIN sp_add_new_ticket(:t, :p, :s, :id); END;`, {
        t: tripId, p: req.session.userId, s: seat,
        id: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 20 }
      });
      booked.push({ seat, ticketId: r.outBinds.id });
    } catch (e) {
      const m = /ORA-200\d\d: ([^\n]*)/.exec(e.message);
      failed.push({ seat, error: m ? m[1] : e.message });
    } finally {
      if (conn) await conn.close();
    }
  }

  if (booked.length && !failed.length) {
    return res.json({ ok: true, message: 'Booked ' + booked.length + ' seat(s): ' +
      booked.map(b => b.seat + ' (' + b.ticketId + ')').join(', ') + '. Payment is pending.' });
  }
  if (booked.length && failed.length) {
    return res.status(207).json({ ok: true,
      message: 'Booked: ' + booked.map(b => b.seat).join(', ') + '. Failed: ' +
        failed.map(f => f.seat + ' (' + f.error + ')').join(', ') });
  }
  res.status(409).json({ error: failed.map(f => f.seat + ': ' + f.error).join(' | ') });
});

app.get('/api/passenger/tickets', need('passenger'), async (req, res) => {
  try {
    const r = await run(`SELECT tk.TICKET_ID, rt.ROUTE_NAME, TO_CHAR(t.TRIP_DATE,'YYYY-MM-DD') AS TRIP_DATE,
        t.DEPARTURE_TIME, tk.SEAT_NUMBER, tk.TICKET_PRICE, tk.STATUS AS TICKET_STATUS, pm.PAYMENT_STATUS
      FROM TICKET tk
      JOIN TRIP t ON t.TRIP_ID = tk.TRIP_ID
      JOIN ROUTE rt ON rt.ROUTE_ID = t.ROUTE_ID
      LEFT JOIN PAYMENT pm ON pm.TICKET_ID = tk.TICKET_ID
      WHERE tk.PASSENGER_ID = :p
      ORDER BY tk.BOOKING_DATE DESC, tk.TICKET_ID DESC`, { p: req.session.userId });
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});




// ---------- Passenger feedback  ----------
app.get('/api/passenger/reviewable', need('passenger'), async (req, res) => {
  try {
    const r = await run(`SELECT DISTINCT t.TRIP_ID, r.ROUTE_NAME, TO_CHAR(t.TRIP_DATE,'YYYY-MM-DD') AS TRIP_DATE
      FROM TICKET tk
      JOIN TRIP t ON t.TRIP_ID = tk.TRIP_ID
      JOIN ROUTE r ON r.ROUTE_ID = t.ROUTE_ID
      WHERE tk.PASSENGER_ID = :p AND tk.STATUS = 'Confirmed' AND t.STATUS = 'Completed'
        AND NOT EXISTS (SELECT 1 FROM FEEDBACK f WHERE f.PASSENGER_ID = tk.PASSENGER_ID AND f.TRIP_ID = t.TRIP_ID)
      ORDER BY TRIP_DATE DESC`, { p: req.session.userId });
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/passenger/feedback', need('passenger'), async (req, res) => {
  const { tripId, rating, comment } = req.body;
  const rt = Number(rating);
  const cm = (comment || '').trim();
  if (!tripId || !Number.isInteger(rt) || rt < 1 || rt > 5)
    return res.status(400).json({ error: 'Choose a rating from 1 to 5' });
  if (!cm || cm.length > 200)
    return res.status(400).json({ error: 'Write a comment (max 200 characters)' });

  const pid = req.session.userId;
  let conn, mongoId = null;
  try {
    conn = await oracledb.getConnection();

    const ok = await conn.execute(
      `SELECT COUNT(*) AS N FROM TICKET tk JOIN TRIP t ON t.TRIP_ID = tk.TRIP_ID
       WHERE tk.PASSENGER_ID = :p AND tk.TRIP_ID = :t AND tk.STATUS = 'Confirmed' AND t.STATUS = 'Completed'`,
      { p: pid, t: tripId });
    if (ok.rows[0].N === 0)
      return res.status(403).json({ error: 'You can only review completed trips that you travelled on' });

    const dup = await conn.execute(
      `SELECT COUNT(*) AS N FROM FEEDBACK WHERE PASSENGER_ID = :p AND TRIP_ID = :t`, { p: pid, t: tripId });
    if (dup.rows[0].N > 0)
      return res.status(409).json({ error: 'You have already reviewed this trip' });

    const info = await conn.execute(
      `SELECT ROUTE_ID, VEHICLE_ID, DRIVER_ID FROM TRIP WHERE TRIP_ID = :t`, { t: tripId });
    const n = await conn.execute(
      `SELECT NVL(MAX(TO_NUMBER(SUBSTR(FEEDBACK_ID,2))),0)+1 AS N FROM FEEDBACK`);
    const fid = 'F' + String(n.rows[0].N).padStart(3, '0');

    // 1) Oracle insert 
    await conn.execute(
      `INSERT INTO FEEDBACK (FEEDBACK_ID,PASSENGER_ID,TRIP_ID,RATING,PASSENGER_COMMENT,FEEDBACK_DATE)
       VALUES (:id,:p,:t,:r,:c,SYSDATE)`,
      { id: fid, p: pid, t: tripId, r: rt, c: cm });

    // 2) MongoDB insert
    const i = info.rows[0];
    const ins = await mongoDb.collection('reviews').insertOne({
      feedback_id: fid, passenger_id: pid, trip_id: tripId,
      route_id: i.ROUTE_ID, vehicle_id: i.VEHICLE_ID, driver_id: i.DRIVER_ID,
      rating: rt, comment: cm, tags: [], complaint: rt <= 3,
      date: new Date().toISOString().slice(0, 10)
    });
    mongoId = ins.insertedId;

    // 3) both 
    await conn.commit();
    res.json({ ok: true, message: 'Thank you! Your feedback ' + fid + ' was saved.' });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    if (mongoId) await mongoDb.collection('reviews').deleteOne({ _id: mongoId }).catch(() => {});
    res.status(500).json({ error: 'Could not save feedback: ' + e.message });
  } finally {
    if (conn) await conn.close();
  }
});


// ---------- MongoDB Insights (Admin) ----------
app.get('/api/admin/mongo/route-reviews', need('admin'), async (req, res) => {
  const routeId = (req.query.routeId || '').trim().toUpperCase();
  if (!routeId) return res.status(400).json({ error: 'Choose a route' });
  const rows = await mongoDb.collection('reviews')
    .find({ route_id: routeId }, { projection: { _id: 0 } })
    .sort({ date: -1 }).toArray();
  res.json(rows);
});

app.get('/api/admin/mongo/top-rated', need('admin'), async (req, res) => {
  const by = req.query.by === 'driver' ? 'driver_id' : 'vehicle_id';
  const rows = await mongoDb.collection('reviews').aggregate([
    { $group: { _id: '$' + by, avgRating: { $avg: '$rating' }, reviews: { $sum: 1 } } },
    { $sort: { avgRating: -1 } },
    { $project: { _id: 0, id: '$_id', avgRating: { $round: ['$avgRating', 2] }, reviews: 1 } }
  ]).toArray();
  res.json(rows);
});

app.get('/api/admin/mongo/search', need('admin'), async (req, res) => {
  const kw = (req.query.kw || '').trim();
  if (!kw) return res.status(400).json({ error: 'Type a keyword' });
  const rows = await mongoDb.collection('reviews')
    .find({ $text: { $search: kw } }, { projection: { _id: 0 } })
    .toArray();
  res.json(rows);
});

app.get('/api/admin/mongo/vehicle-docs', need('admin'), async (req, res) => {
  const vehicleId = (req.query.vehicleId || '').trim().toUpperCase();
  if (!vehicleId) return res.status(400).json({ error: 'Choose a vehicle' });
  const doc = await mongoDb.collection('vehicle_documents').findOne(
    { vehicle_id: vehicleId }, { projection: { _id: 0 } });
  res.json(doc || { vehicle_id: vehicleId, documents: [], images: [] });
});





// ---------- Admin: manage vehicle documents & images (MongoDB) ----------
const ICONS = ['Three-Wheeler', 'Car', 'Van', 'Bus'];
const ICON_URL = { 'Three-Wheeler': '/images/three_wheeler.svg', 'Car': '/images/car.svg', 'Van': '/images/van.svg', 'Bus': '/images/bus.svg' };

app.put('/api/admin/mongo/vehicle-image', need('admin'), async (req, res) => {
  const { vehicleId, iconType } = req.body;
  if (!vehicleId || !ICONS.includes(iconType)) return res.status(400).json({ error: 'Choose a valid vehicle and icon' });
  try {
    await mongoDb.collection('vehicle_documents').updateOne(
      { vehicle_id: vehicleId.toUpperCase() },
      { $set: { images: [{ type: 'front', url: ICON_URL[iconType] }, { type: 'side', url: ICON_URL[iconType] }] } },
      { upsert: true });
    res.json({ ok: true, message: 'Vehicle image updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Admin: upload real PDF documents ----------
const docDir = path.join(__dirname, 'public', 'documents');
if (!fs.existsSync(docDir)) fs.mkdirSync(docDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, docDir),
    filename: (req, file, cb) => {
      const safeType = (req.body.docType || 'document').replace(/\s+/g, '_');
      cb(null, (req.body.vehicleId || 'V000').toUpperCase() + '_' + safeType + '.pdf');
    }
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Only PDF files are allowed'));
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.post('/api/admin/mongo/vehicle-doc', need('admin'), (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const { vehicleId, docType } = req.body;
    if (!vehicleId || !docType || !req.file)
      return res.status(400).json({ error: 'Choose vehicle, document type and a PDF file' });
    try {
      const vId = vehicleId.toUpperCase();
      await mongoDb.collection('vehicle_documents').updateOne(
        { vehicle_id: vId }, { $pull: { documents: { type: docType } } });
      await mongoDb.collection('vehicle_documents').updateOne(
        { vehicle_id: vId },
        { $push: { documents: { type: docType, file_name: req.file.filename, url: '/documents/' + req.file.filename } } },
        { upsert: true });
      res.json({ ok: true, message: docType + ' uploaded for ' + vId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

app.delete('/api/admin/mongo/vehicle-doc', need('admin'), async (req, res) => {
  const { vehicleId, docType, fileName } = req.body;
  if (!vehicleId || !docType) return res.status(400).json({ error: 'Fill all fields' });
  try {
    await mongoDb.collection('vehicle_documents').updateOne(
      { vehicle_id: vehicleId.toUpperCase() }, { $pull: { documents: { type: docType } } });
    if (fileName) fs.unlink(path.join(docDir, fileName), () => {});
    res.json({ ok: true, message: docType + ' removed for ' + vehicleId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});







// ---------- Start ----------
(async () => {
  await oracledb.createPool({
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECT
  });
  const client = await MongoClient.connect(process.env.MONGO_URI);
  mongoDb = client.db('SmartMoveDB');
  app.listen(process.env.PORT || 3000, () =>
    console.log('SmartMove running -> http://localhost:' + (process.env.PORT || 3000)));
})().catch(e => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});