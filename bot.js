const TelegramBot = require('node-telegram-bot-api');
const Datastore = require('nedb');

// Ganti dengan token API bot Anda
const token = '8326864561:AAHsOmwu0jKhKcSAdXubqTzALdOgKiBNWyo';
const bot = new TelegramBot(token, { polling: true });

// Objek untuk menyimpan state percakapan setiap pengguna
const userState = {};

// Database untuk menyimpan ID channel
const db = new Datastore({ filename: 'channels.db', autoload: true });

// Fungsi untuk memeriksa apakah bot sudah admin di channel atau tidak
async function isBotAdmin(channelId) {
    try {
        const chatMember = await bot.getChatMember(channelId, bot.options.token.split(':')[0]);
        return chatMember.status === 'administrator';
    } catch (e) {
        return false;
    }
}

// Handler untuk perintah /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    // Periksa apakah ini adalah percakapan pribadi
    if (msg.chat.type !== 'private') {
        bot.sendMessage(chatId, 'Silakan gunakan bot ini di percakapan pribadi.');
        return;
    }

    userState[chatId] = { step: 'menu' };
    bot.sendMessage(chatId, 'Selamat datang di bot pengelola posting! Pilih menu di bawah ini:', {
        reply_markup: {
            keyboard: [
                [{ text: 'Buat Post Baru' }],
                [{ text: 'Lihat Channel Saya' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    });
});

// Handler untuk tombol "Buat Post Baru"
bot.onText(/Buat Post Baru/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return;

    // Periksa apakah ada channel yang terdaftar
    db.find({}, (err, docs) => {
        if (docs.length === 0) {
            bot.sendMessage(chatId, 'Anda belum menambahkan bot ini ke channel mana pun. Tambahkan bot ini sebagai admin di channel Anda terlebih dahulu.');
        } else {
            userState[chatId] = { step: 'text' };
            bot.sendMessage(chatId, 'Silakan kirim teks yang ingin Anda posting.');
        }
    });
});

// Handler untuk tombol "Lihat Channel Saya"
bot.onText(/Lihat Channel Saya/, (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return;

    db.find({}, (err, docs) => {
        if (docs.length === 0) {
            bot.sendMessage(chatId, 'Anda belum menambahkan bot ini ke channel mana pun.');
        } else {
            let channelList = "Berikut adalah ID channel yang terdaftar:\n\n";
            docs.forEach(doc => {
                channelList += `${doc.id}\n`;
            });
            bot.sendMessage(chatId, channelList);
        }
    });
});

// Handler untuk mendeteksi bot yang ditambahkan sebagai admin di channel baru
bot.on('new_chat_members', async (msg) => {
    const newMember = msg.new_chat_members.find(member => member.id === bot.options.token.split(':')[0]);

    if (newMember) {
        const chatId = msg.chat.id;
        const chatType = msg.chat.type;

        // Hanya proses jika bot ditambahkan ke channel
        if (chatType === 'channel') {
            const botIsAdmin = await isBotAdmin(chatId);
            if (botIsAdmin) {
                // Simpan ID channel ke database
                db.update({ id: chatId }, { id: chatId, title: msg.chat.title }, { upsert: true }, (err, numReplaced, upsert) => {
                    if (err) console.error(err);
                    else {
                        if (upsert) {
                            console.log(`Channel baru ditambahkan: ${msg.chat.title} (${chatId})`);
                        } else {
                            console.log(`Channel ${msg.chat.title} (${chatId}) sudah ada.`);
                        }
                    }
                });
            }
        }
    }
});

// Handler untuk menerima semua jenis pesan (teks atau foto)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    // Abaikan jika bukan dari percakapan pribadi
    if (msg.chat.type !== 'private') return;
    if (!userState[chatId]) return;

    // Jika pengguna sedang dalam tahap input teks
    if (userState[chatId].step === 'text' && msg.text) {
        userState[chatId] = { step: 'photo', text: msg.text };
        bot.sendMessage(chatId, 'Terimakasih. Sekarang kirimkan foto untuk postingan Anda.');

    // Jika pengguna sedang dalam tahap input foto
    } else if (userState[chatId].step === 'photo' && msg.photo) {
        const photo = msg.photo[msg.photo.length - 1].file_id;
        const caption = userState[chatId].text;

        await bot.sendMessage(chatId, "Baik, saya akan mulai mengirimkan postingan Anda ke semua channel.");

        // Ambil semua channel dari database
        db.find({}, async (err, docs) => {
            if (err) {
                console.error(err);
                bot.sendMessage(chatId, 'Terjadi kesalahan saat mengambil daftar channel.');
                return;
            }
            if (docs.length === 0) {
                bot.sendMessage(chatId, 'Tidak ada channel yang terdaftar. Postingan dibatalkan.');
                userState[chatId] = { step: 'menu' };
                return;
            }

            for (const doc of docs) {
                try {
                    await bot.sendPhoto(doc.id, photo, { caption: caption });
                    console.log(`Pesan berhasil dikirim ke channel ${doc.id}`);
                } catch (e) {
                    console.error(`Gagal mengirim ke channel ${doc.id}: ${e.message}`);
                    // Opsi: Hapus channel yang tidak bisa dikirim dari database
                    if (e.message.includes('chat not found')) {
                         console.log(`Menghapus channel ${doc.id} dari database.`);
                         db.remove({ id: doc.id }, {}, (err, numRemoved) => {});
                    }
                }
            }
            
            // Setelah selesai, beri tahu pengguna
            bot.sendMessage(chatId, 'Postingan Anda berhasil dikirim ke semua channel!');
            userState[chatId] = { step: 'done' };
        });
    }
});

console.log('Bot sedang berjalan...');