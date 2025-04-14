// app.js (Root of your project)

const express = require('express');
const path = require('path');
const db = require('./database/connection');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const app = express();
const port = 8200;

// --- Middleware Setup ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware to parse URL-encoded bodies (as sent by HTML forms)
app.use(express.urlencoded({ extended: true }));
// Middleware to parse JSON bodies (if you use AJAX/APIs)
app.use(express.json());

// static files (CSS, client-side JS, images) from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware setup
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: path.join(__dirname, 'database')
  }),
  secret: 'your_secret_key_here',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// --- Routes ---
app.use('/', require('./routes/home'));
app.use('/auth', require('./routes/auth'));
app.use('/guest', require('./routes/guest'));

app.use((req, res, next) => {
  res.status(404).render('error/404', { title: 'Page Not Found' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error/500', { title: 'Server Error' });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});