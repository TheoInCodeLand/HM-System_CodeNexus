// routes/housekeeping.js

const express = require('express');
const db = require('../database/connection'); // Adjust path as needed
const router = express.Router();

// --- Middleware to ensure user is logged in as Housekeeping (or relevant staff) ---
function ensureHousekeeping(req, res, next) {
    // Adjust role check if you have a general 'staff' role or specific 'housekeeping' role
    if (req.session.user && (req.session.user.role === 'housekeeping' || req.session.user.role === 'admin')) {
        return next();
    } else {
        // Redirect to login if not authorized
        res.redirect('/login');
    }
}

// Apply the middleware to all routes in this file
router.use(ensureHousekeeping);

// --- GET /housekeeping/dashboard ---
// Shows a dashboard for housekeeping staff.
// Might list rooms needing service, recent logs, etc.
router.get('/dashboard', (req, res) => {
    // Example: Fetch rooms that might need cleaning (e.g., 'occupied' or 'departed' status)
    // You might need more complex logic based on check-out dates, guest requests etc.
    const roomSql = `SELECT id, room_number, status FROM rooms WHERE status = 'occupied' OR status = 'needs_cleaning' ORDER BY room_number ASC`;

    // Example: Fetch recent logs made by this user
    const logSql = `SELECT hl.*, r.room_number
                    FROM housekeeping_logs hl
                    JOIN rooms r ON hl.room_id = r.id
                    WHERE hl.staff_user_id = ?
                    ORDER BY hl.log_time DESC LIMIT 10`;

    Promise.all([
        new Promise((resolve, reject) => {
            db.all(roomSql, [], (err, rooms) => {
                if (err) return reject(`Error fetching rooms: ${err.message}`);
                resolve(rooms);
            });
        }),
        new Promise((resolve, reject) => {
            db.all(logSql, [req.session.user.id], (err, logs) => {
                 if (err) return reject(`Error fetching logs: ${err.message}`);
                 resolve(logs);
            });
        })
    ])
    .then(([rooms, recentLogs]) => {
        res.render('staff/housekeeping_dashboard', { // Assumes views/staff/housekeeping_dashboard.ejs
            title: 'Housekeeping Dashboard',
            user: req.session.user,
            rooms: rooms,
            recentLogs: recentLogs
        });
    })
    .catch(error => {
        console.error("Error loading housekeeping dashboard:", error);
        res.redirect('/'); // Redirect home on error
    });
});

// --- GET /housekeeping/log/room/:roomId ---
// Shows a form to log cleaning details for a specific room
router.get('/log/room/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const roomSql = `SELECT id, room_number FROM rooms WHERE id = ?`;
    // Also fetch guest preferences for this room if applicable (to show linen opt-out)
    const prefSql = `SELECT gp.opt_out_linen_change
                     FROM guest_preferences gp
                     JOIN users u ON gp.guest_user_id = u.id
                     -- You might need a way to link current guest to room_id, e.g., via a 'stays' table
                     -- Simplified: Assumes only one guest preference matters per room for now
                     WHERE gp.room_id = ?
                     LIMIT 1`;

     Promise.all([
         new Promise((resolve, reject) => {
             db.get(roomSql, [roomId], (err, room) => {
                 if (err) return reject(`Error fetching room: ${err.message}`);
                 if (!room) return reject('Room not found');
                 resolve(room);
             });
         }),
          new Promise((resolve, reject) => {
              db.get(prefSql, [roomId], (err, preference) => {
                  // Don't reject if preferences not found, just resolve null/default
                  if (err) console.error("Error fetching guest preference:", err.message);
                  resolve(preference || { opt_out_linen_change: 0 });
              });
          })
     ])
    .then(([room, preference]) => {
         res.render('staff/housekeeping_log_form', { // Assumes views/staff/housekeeping_log_form.ejs
             title: `Log for Room ${room.room_number}`,
             user: req.session.user,
             room: room,
             preference: preference
         });
    })
    .catch(error => {
         console.error("Error loading log form:", error);
         // Redirect or show error
         res.redirect('/housekeeping/dashboard');
    });
});


// --- POST /housekeeping/log ---
// Handles submission of the housekeeping log form
router.post('/log', (req, res) => {
    const staffUserId = req.session.user.id;
    const { room_id, linen_changed, towels_changed, waste_reported, damage_reported } = req.body;

    // Convert checkbox values ('on' or undefined) to boolean/integer (1 or 0)
    const linenChangedVal = linen_changed === 'on' ? 1 : 0;
    const towelsChangedVal = towels_changed === 'on' ? 1 : 0;

    if (!room_id) {
        console.error("Missing room_id in housekeeping log submission");
        return res.redirect('/housekeeping/dashboard?log_status=error&message=MissingRoomID');
    }

    const insertLogSql = `INSERT INTO housekeeping_logs
                 (room_id, staff_user_id, linen_changed, towels_changed, waste_reported, damage_reported)
                 VALUES (?, ?, ?, ?, ?, ?)`;

    // First, insert the log
    db.run(insertLogSql, [room_id, staffUserId, linenChangedVal, towelsChangedVal, waste_reported, damage_reported], function(err) {
        if (err) {
            console.error("Error inserting housekeeping log:", err.message);
            // Redirect back with error status
            res.redirect('/housekeeping/dashboard?log_status=error&message=InsertFailed');
        } else {
            const newLogId = this.lastID; // Get the ID of the log just inserted
            console.log(`New housekeeping log created with ID ${newLogId} for room ${room_id} by user ${staffUserId}`);

            // --- Optional Feature: Update Room Status ---
            // Now, attempt to update the room status if it was 'needs_cleaning'
            // You might adjust the logic based on your specific room statuses
            const updateRoomSql = `UPDATE rooms SET status = 'available' WHERE id = ? AND status = 'needs_cleaning'`;

            db.run(updateRoomSql, [room_id], function(updateErr) {
                if (updateErr) {
                    // Log the error but don't necessarily stop the process,
                    // as the main log was successful.
                    console.error(`Error updating room status for room ${room_id} after log insertion:`, updateErr.message);
                    // Redirect with success for the log, but maybe indicate room status update failed
                    res.redirect('/housekeeping/dashboard?log_status=success&room_update_status=error');
                } else {
                    if (this.changes > 0) {
                        console.log(`Room ${room_id} status updated to 'available'.`);
                    } else {
                        // This means the room wasn't updated, likely because its status wasn't 'needs_cleaning'
                        console.log(`Room ${room_id} status not updated (was not 'needs_cleaning' or room ID invalid).`);
                    }
                    // Redirect after successful log insertion AND room status update attempt
                    res.redirect('/housekeeping/dashboard?log_status=success&room_update_status=attempted');
                }
            });
            // --- End Optional Feature ---
        }
    });
});

// Add these routes inside routes/housekeeping.js, before module.exports

// --- GET /housekeeping/logs ---
// Displays a more detailed list of housekeeping logs, potentially with filtering
router.get('/logs', (req, res) => {
    // Example: Fetch all logs, joining with user and room names
    // Add pagination in a real application for large datasets
    const sql = `SELECT
                    hl.log_id,
                    hl.log_time,
                    r.room_number,
                    u.username as staff_username,
                    hl.linen_changed,
                    hl.towels_changed,
                    hl.waste_reported,
                    hl.damage_reported
                 FROM housekeeping_logs hl
                 JOIN rooms r ON hl.room_id = r.id
                 JOIN users u ON hl.staff_user_id = u.id
                 ORDER BY hl.log_time DESC`; // Show most recent first

    db.all(sql, [], (err, logs) => {
        if (err) {
            console.error("Error fetching detailed housekeeping logs:", err.message);
            // Redirect to dashboard or show an error
            return res.redirect('/housekeeping/dashboard');
        }

        res.render('staff/housekeeping_logs_list', { // Assumes views/staff/housekeeping_logs_list.ejs
            title: 'Detailed Housekeeping Logs',
            user: req.session.user,
            logs: logs // Pass the fetched logs array to the view
        });
    });
});


// --- GET /housekeeping/supplies ---
// Displays current housekeeping supply levels
router.get('/supplies', (req, res) => {
    const sql = `SELECT id, item_name, current_stock, reorder_level, unit, last_updated
                 FROM housekeeping_supplies
                 ORDER BY item_name ASC`;

    db.all(sql, [], (err, supplies) => {
        if (err) {
            console.error("Error fetching housekeeping supplies:", err.message);
            // Redirect or show error
            return res.redirect('/housekeeping/dashboard');
        }

        res.render('staff/housekeeping_supplies', { // Assumes views/staff/housekeeping_supplies.ejs
            title: 'Housekeeping Supplies Stock',
            user: req.session.user,
            supplies: supplies // Pass the supply list to the view
        });
    });
});

// --- POST /housekeeping/supplies/update ---
// Simple example route to update stock for a single item
router.post('/supplies/update', (req, res) => {
    const { supply_id, change_amount } = req.body; // Expecting item ID and the amount to add/subtract

    if (!supply_id || change_amount === undefined || isNaN(parseInt(change_amount))) {
         console.error("Invalid input for supply update:", req.body);
         // Redirect back with error message - ideally use flash messages
         return res.redirect('/housekeeping/supplies?update_status=error');
    }

    const amount = parseInt(change_amount);

    // Update stock level atomically and set last_updated time
    const sql = `UPDATE housekeeping_supplies
                 SET current_stock = current_stock + ?,
                     last_updated = CURRENT_TIMESTAMP
                 WHERE id = ?`;

    db.run(sql, [amount, supply_id], function(err) {
         if (err) {
            console.error("Error updating supply stock:", err.message);
            return res.redirect('/housekeeping/supplies?update_status=db_error');
         }
         if (this.changes === 0) {
             console.error(`Supply item with id ${supply_id} not found for update.`);
             return res.redirect('/housekeeping/supplies?update_status=not_found');
         }

         console.log(`Updated stock for supply ID ${supply_id} by ${amount}.`);
         res.redirect('/housekeeping/supplies?update_status=success');
    });
});

module.exports = router;