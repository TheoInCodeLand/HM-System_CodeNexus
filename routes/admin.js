const express = require('express');
const db = require('../database/connection'); // Adjust path as needed
const router = express.Router();

// --- Middleware to ensure user is logged in as Admin ---
function ensureAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    } else {
        res.status(403).send('Unauthorized access.');
    }
}

router.use(ensureAdmin);

// Admin Dashboard
router.get('/dashboard', (req, res) => {
    res.render('admin/admin_dashboard', {
        title: 'Admin Dashboard',
        user: req.session.user
    });
});

// --- Room Management: List Rooms ---
router.get('/rooms', (req, res) => {
    const sql = `SELECT r.id, r.room_number, r.status, u.username as guest_username
                 FROM rooms r
                 LEFT JOIN guest_preferences gp ON r.id = gp.room_id
                 LEFT JOIN users u ON gp.guest_user_id = u.id
                 ORDER BY r.room_number ASC`;

    db.all(sql, [], (err, rooms) => {
        if (err) {
            console.error("Error fetching rooms:", err.message);
            return res.redirect('/admin/dashboard?status=error');
        }
        res.render('admin/admin_room_list', {
            title: 'Manage Rooms',
            user: req.session.user,
            rooms,
            allowedStatuses: ['available', 'occupied', 'needs_cleaning', 'maintenance'],
            query: req.query
        });
    });
});

// --- Add New Room ---
router.get('/rooms/add', (req, res) => {
    res.render('admin/admin_room_form', {
        title: 'Add New Room',
        user: req.session.user,
        room: null,
        form_action: '/admin/rooms/add'
    });
});

router.post('/rooms/add', (req, res) => {
    const { room_number, status } = req.body;
    const allowedStatuses = ['available', 'occupied', 'needs_cleaning', 'maintenance'];
    const initialStatus = (status && allowedStatuses.includes(status)) ? status : 'available';

    if (!room_number) {
        return res.redirect('/admin/rooms/add?status=error&message=RoomNumberRequired');
    }

    const sql = `INSERT INTO rooms (room_number, status) VALUES (?, ?)`;
    db.run(sql, [room_number, initialStatus], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint')) {
                return res.redirect('/admin/rooms/add?status=error&message=RoomNumberExists');
            }
            return res.redirect('/admin/rooms/add?status=error');
        }
        res.redirect('/admin/rooms?status=added');
    });
});

// --- Update Room Status ---
router.post('/rooms/status/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const { new_status } = req.body;
    const allowedStatuses = ['available', 'occupied', 'needs_cleaning', 'maintenance'];

    if (!allowedStatuses.includes(new_status)) {
        return res.redirect('/admin/rooms?update_status=error');
    }

    const sql = `UPDATE rooms SET status = ? WHERE id = ?`;
    db.run(sql, [new_status, roomId], function (err) {
        if (err || this.changes === 0) {
            return res.redirect('/admin/rooms?update_status=error');
        }

        if (['available', 'needs_cleaning', 'maintenance'].includes(new_status)) {
            const clearPrefSql = `UPDATE guest_preferences SET room_id = NULL WHERE room_id = ?`;
            db.run(clearPrefSql, [roomId], () => res.redirect('/admin/rooms?update_status=success'));
        } else {
            res.redirect('/admin/rooms?update_status=success');
        }
    });
});

// --- Check-in Route (Create booking) ---
router.post('/checkin/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const { guest_user_id } = req.body;

    if (!guest_user_id) {
        return res.redirect('/admin/rooms?checkin_status=missing_guest');
    }

    const updateRoomSql = `UPDATE rooms SET status = 'occupied' WHERE id = ? AND status = 'available'`;
    db.run(updateRoomSql, [roomId], function (err) {
        if (err || this.changes === 0) {
            return res.redirect('/admin/rooms?checkin_status=room_unavailable');
        }

        const bookingSql = `INSERT INTO bookings (guest_user_id, room_id, check_in_date) VALUES (?, ?, datetime('now'))`;
        db.run(bookingSql, [guest_user_id, roomId], function (bookingErr) {
            if (bookingErr) {
                console.error("Booking insert failed:", bookingErr.message);
            }

            const updatePrefSql = `UPDATE guest_preferences SET room_id = ? WHERE guest_user_id = ?`;
            db.run(updatePrefSql, [roomId, guest_user_id], (prefErr) => {
                if (prefErr) console.error("Guest preference update failed:", prefErr.message);
                res.redirect('/admin/rooms?checkin_status=success');
            });
        });
    });
});

// --- Check-out Route (Update booking) ---
router.post('/checkout/:roomId', (req, res) => {
    const roomId = req.params.roomId;

    const updateRoomSql = `UPDATE rooms SET status = 'needs_cleaning' WHERE id = ? AND status = 'occupied'`;
    db.run(updateRoomSql, [roomId], function (err) {
        if (err || this.changes === 0) {
            return res.redirect('/admin/rooms?checkout_status=room_not_occupied');
        }

        const updateBookingSql = `
            UPDATE bookings
            SET check_out_date = datetime('now')
            WHERE room_id = ? AND check_out_date IS NULL
            ORDER BY id DESC LIMIT 1
        `;
        db.run(updateBookingSql, [roomId], (bookingErr) => {
            if (bookingErr) console.error("Error updating booking:", bookingErr.message);

            const clearPrefSql = `UPDATE guest_preferences SET room_id = NULL WHERE room_id = ?`;
            db.run(clearPrefSql, [roomId], (prefErr) => {
                if (prefErr) console.error("Clearing guest preference failed:", prefErr.message);
                res.redirect('/admin/rooms?checkout_status=success');
            });
        });
    });
});

module.exports = router;
