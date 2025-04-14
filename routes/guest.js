const express = require('express');
const db = require('../database/connection');
const router = express.Router();

function ensureGuest(req, res, next) {
    if (req.session.user && req.session.user.role === 'guest') {
        return next();
    } else {
        res.redirect('/login');
    }
}

router.use(ensureGuest);

router.get('/dashboard', (req, res) => {
    const guestUserId = req.session.user.id;
    let guestData = {
        preferences: null,
        metrics: null,
        tips: []
    };

    // Use Promise.all to fetch data concurrently
    Promise.all([
        // 1. Fetch Guest Preferences
        new Promise((resolve, reject) => {
            const prefSql = `SELECT * FROM guest_preferences WHERE guest_user_id = ?`;
            db.get(prefSql, [guestUserId], (err, row) => {
                if (err) return reject(`Error fetching preferences: ${err.message}`);
                // Initialize preferences if none exist for the guest yet
                if (!row) {
                    const insertPrefSql = `INSERT INTO guest_preferences (guest_user_id) VALUES (?)`;
                    db.run(insertPrefSql, [guestUserId], function(err) {
                         if (err) return reject(`Error initializing preferences: ${err.message}`);
                         db.get(prefSql, [guestUserId], (err, newRow) => {
                             if(err) return reject(`Error fetching new preferences: ${err.message}`);
                             resolve(newRow);
                         });
                    });
                } else {
                    resolve(row);
                }
            });
        }),
        // 2. Fetch Guest Metrics (Points, Footprint)
        new Promise((resolve, reject) => {
            const metricsSql = `SELECT * FROM guest_metrics WHERE guest_user_id = ? ORDER BY metric_time DESC LIMIT 1`; // Get latest metrics
            db.get(metricsSql, [guestUserId], (err, row) => {
                if (err) return reject(`Error fetching metrics: ${err.message}`);
                resolve(row || { green_points: 0, carbon_footprint_estimate: 0 }); // Default if no metrics exist
            });
        }),
        // 3. Fetch Relevant Tips
        new Promise((resolve, reject) => {
            const tipsSql = `SELECT content FROM tips_alerts WHERE (target_audience = 'all' OR target_audience = 'guest') AND is_active = 1 ORDER BY RANDOM() LIMIT 3`; // Get 3 random relevant tips
            db.all(tipsSql, [], (err, rows) => {
                if (err) return reject(`Error fetching tips: ${err.message}`);
                resolve(rows);
            });
        })
    ])
    .then(([preferences, metrics, tips]) => {
        guestData.preferences = preferences;
        guestData.metrics = metrics;
        guestData.tips = tips;

        res.render('guest/dashboard', {
            title: 'Your Dashboard',
            user: req.session.user,
            guestData: guestData
        });
    })
    .catch(error => {
        console.error("Error loading guest dashboard:", error);
        res.redirect('/');
    });
});

// --- POST /guest/preferences/linen ---
// Updates the guest's preference for linen changes
router.post('/preferences/linen', (req, res) => {
    const guestUserId = req.session.user.id;
    // Get the value from the form; checkbox sends 'on' if checked, undefined otherwise
    const optOutLinen = req.body.opt_out_linen === 'on' ? 1 : 0;

    const sql = `UPDATE guest_preferences SET opt_out_linen_change = ?, updated_at = CURRENT_TIMESTAMP WHERE guest_user_id = ?`;

    db.run(sql, [optOutLinen, guestUserId], function(err) {
        if (err) {
            console.error("Error updating linen preference:", err.message);
            // Handle error appropriately - maybe flash message
        } else {
            console.log(`Linen preference updated for user ${guestUserId}`);
            // Optionally add a success message
        }
        res.redirect('/guest/dashboard'); // Redirect back to the dashboard
    });
});

// --- POST /guest/preferences/dnd ---
// Updates the guest's Do Not Disturb status
router.post('/preferences/dnd', (req, res) => {
    const guestUserId = req.session.user.id;
    const doNotDisturb = req.body.do_not_disturb === 'on' ? 1 : 0;

    const sql = `UPDATE guest_preferences SET do_not_disturb = ?, updated_at = CURRENT_TIMESTAMP WHERE guest_user_id = ?`;

    db.run(sql, [doNotDisturb, guestUserId], function(err) {
        if (err) {
            console.error("Error updating DND preference:", err.message);
            // Handle error
        } else {
            console.log(`DND status updated for user ${guestUserId}`);
            // Optionally add a success message
        }
        res.redirect('/guest/dashboard'); // Redirect back to the dashboard
    });
});

// --- Add other guest-specific routes here ---
// Example: Route to view detailed points history or tips archive
router.get('/points-history', (req, res) => {
    const guestUserId = req.session.user.id;

    const sql = `SELECT metric_time, green_points, carbon_footprint_estimate -- Add other relevant fields if you store reasons for point changes
                 FROM guest_metrics
                 WHERE guest_user_id = ?
                 ORDER BY metric_time DESC`; // Show most recent first

    db.all(sql, [guestUserId], (err, history) => {
        if (err) {
            console.error("Error fetching points history:", err.message);
            // Redirect to dashboard or show an error message
            return res.redirect('/guest/dashboard');
        }

        res.render('guest/points_history', { // Assumes you create views/guest/points_history.ejs
            title: 'Points History',
            user: req.session.user,
            history: history // Pass the fetched history array to the view
        });
    });
});

// --- GET /guest/tips-archive ---
// Displays a list or archive of all relevant tips
router.get('/tips-archive', (req, res) => {
    const sql = `SELECT content, category, created_at -- Select relevant fields
                 FROM tips_alerts
                 WHERE (target_audience = 'all' OR target_audience = 'guest') AND is_active = 1
                 ORDER BY created_at DESC`; // Show newest tips first

    db.all(sql, [], (err, tips) => {
        if (err) {
            console.error("Error fetching tips archive:", err.message);
            // Redirect to dashboard or show an error message
            return res.redirect('/guest/dashboard');
        }

        res.render('guest/tips_archive', { // Assumes you create views/guest/tips_archive.ejs
            title: 'Tips Archive',
            user: req.session.user,
            tips: tips
        });
    });
});

module.exports = router;