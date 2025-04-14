const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database/connection.js');

const router = express.Router();
const saltRounds = 10;

router.post('/register', (req, res) => {
    const { username, password, confirm_password, role, full_name, email } = req.body;

    if (!username || !password || !role) {
        return res.render('auth/register', { title: 'Register', error: 'Username, password, and role are required.' });
    }
    if (password !== confirm_password) {
        return res.render('auth/register', { title: 'Register', error: 'Passwords do not match.' });
    }
    
    const allowedRoles = ['guest', 'housekeeping', 'maintenance', 'kitchen', 'admin'];
    if (!allowedRoles.includes(role)) {
        return res.render('auth/register', { title: 'Register', error: 'Invalid role selected.' });
    }

    const checkSql = `SELECT * FROM users WHERE username = ? OR email = ?`;
    db.get(checkSql, [username, email], (err, row) => {
        if (err) {
            console.error("Database error during registration check:", err.message);
            return res.render('auth/register', { title: 'Register', error: 'An error occurred. Please try again.' });
        }
        if (row) {
            // Username or email already exists
            const message = row.username === username ? 'Username already exists.' : 'Email already registered.';
            return res.render('auth/register', { title: 'Register', error: message });
        }

        bcrypt.hash(password, saltRounds, (err, hashedPassword) => {
            if (err) {
                console.error("Error hashing password:", err.message);
                return res.render('auth/register', { title: 'Register', error: 'An error occurred during registration.' });
            }

            const insertSql = `INSERT INTO users (username, password, role, full_name, email) VALUES (?, ?, ?, ?, ?)`;
            db.run(insertSql, [username, hashedPassword, role, full_name, email], function(err) { // Use function() to access this.lastID
                if (err) {
                    console.error("Database error during user insertion:", err.message);
                    return res.render('auth/register', { title: 'Register', error: 'Failed to register user.' });
                }
                console.log(`An ${role} user, with username: ${username} registered with ID: ${this.lastID}`);
                res.redirect('/login');
            });
        });
    });
});

// --- POST /login ---
router.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.render('auth/login', { title: 'Login', error: 'Please enter username and password.' });
    }
    
    const sql = `SELECT id, username, password, role FROM users WHERE username = ?`;
    db.get(sql, [username], (err, user) => {
        if (err) {
            console.error("Database error during login:", err.message);
            return res.render('auth/login', { title: 'Login', error: 'An error occurred. Please try again.' });
        }

        if (!user) {
            return res.render('auth/login', { title: 'Login', error: 'user does not exist' });
        }
        
        bcrypt.compare(password, user.password, (err, isMatch) => {
            if (err) {
                console.error("Error comparing passwords:", err.message);
                return res.render('auth/login', { title: 'Login', error: 'An error occurred during login.' });
            }

            if (isMatch) {
                req.session.user = {
                    id: user.id,
                    username: user.username,
                    role: user.role
                };

                console.log(`user "${user.username}" with Role: "${user.role}" logged in.`);

                // --- Redirect based on role ---
                switch (user.role) {
                    case 'guest':
                        res.redirect('/guest/dashboard'); // Example guest dashboard route
                        break;
                    case 'admin':
                    case 'housekeeping':
                    case 'maintenance':
                    case 'kitchen':
                        res.redirect('/housekeeping/dashboard'); // Example generic staff dashboard route
                        break;
                    default:
                        res.redirect('/');
                }
            } else {
                return res.render('auth/login', { title: 'Login', error: 'invalid credentials.' });
                console.log(`Invalid credentials for user ${username}.`);
            }
        });
    });
});

// --- GET /logout ---
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Session destruction error:', err);
            return res.redirect('/');
        }

        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});


module.exports = router;