const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const USERS_FILE = path.join(__dirname, 'users.csv');
function getTransporter() {
  return nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    family: 4,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}
function saveUserToCSV(email, name) {
  const timestamp = new Date().toISOString();
  const line = '"' + name + '","' + email + '","' + timestamp + '","free"\n';
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, '"Name","Email","Signup Date","Plan"\n');
  }
  fs.appendFileSync(USERS_FILE, line);
}
async function sendOTPEmail(email, name, code) {
  const transporter = getTransporter();
  await transporter.sendMail({
    from: '"KryptoInsides" <' + process.env.SMTP_USER + '>',
    to: email,
    subject: code + ' is your KryptoInsides code',
    html: '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:sans-serif;">' +
      '<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">' +
      '<tr><td align="center">' +
      '<table width="520" cellpadding="0" cellspacing="0" style="background:#111111;border-radius:16px;border:1px solid #1a1a1a;max-width:520px;width:100%;">' +
      '<tr><td style="background:linear-gradient(135deg,#00b894,#00cec9);padding:28px 32px;border-radius:16px 16px 0 0;">' +
      '<div style="font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">KryptoInsides</div>' +
      '<div style="font-size:13px;color:rgba(255,255,255,0.8);margin-top:4px;">Real-Time Crypto Intelligence</div>' +
      '</td></tr>' +
      '<tr><td style="padding:36px 32px;">' +
      '<p style="color:#f1f1f1;font-size:16px;margin:0 0 8px;">Hey ' + (name || 'there') + ',</p>' +
      '<p style="color:#888888;font-size:14px;margin:0 0 32px;">Your sign in code is:</p>' +
      '<div style="background:#0a0a0a;border:2px solid #00b894;border-radius:14px;padding:24px;text-align:center;margin-bottom:28px;">' +
      '<div style="font-size:48px;font-weight:800;color:#00b894;letter-spacing:12px;font-family:monospace;">' + code + '</div>' +
      '</div>' +
      '<p style="color:#888888;font-size:13px;margin:0 0 8px;">Enter this code on the KryptoInsides sign in page.</p>' +
      '<p style="color:#555555;font-size:12px;margin:0;">This code expires in <b style="color:#888">10 minutes</b>. If you did not request this, ignore this email.</p>' +
      '</td></tr>' +
      '<tr><td style="padding:20px 32px;border-top:1px solid #1a1a1a;text-align:center;">' +
      '<p style="color:#444;font-size:11px;margin:0;">KryptoInsides &middot; info@kryptoinsides.com</p>' +
      '</td></tr>' +
      '</table></td></tr></table></body></html>'
  });
}
async function notifyAdmin(email, name) {
  const transporter = getTransporter();
  await transporter.sendMail({
    from: '"KryptoInsides" <' + process.env.SMTP_USER + '>',
    to: process.env.ADMIN_EMAIL || 'adeezzafar@gmail.com',
    subject: 'New signup: ' + name + ' (' + email + ')',
    html: '<div style="font-family:sans-serif;padding:20px;background:#f9f9f9;"><h2 style="color:#00b894;">New KryptoInsides Signup</h2><p><b>Name:</b> ' + name + '</p><p><b>Email:</b> ' + email + '</p><p><b>Time:</b> ' + new Date().toLocaleString() + '</p></div>'
  });
}
module.exports = { sendOTPEmail, notifyAdmin, saveUserToCSV };
