const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./database/Hotel.db', (err)=> {
    if (err) {
        console.error(err.message, 'Failed to connect to the hotel database!');
    } else {
        console.log('Connected to the hotel database.');
    }
});

module.exports = db;