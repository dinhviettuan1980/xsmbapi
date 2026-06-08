const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID); // lấy từ env

// Xác minh một Google ID token, trả về payload nếu hợp lệ, ném lỗi nếu không.
// Tách riêng để chỗ khác (vd zaloAuth) tái sử dụng mà không cần là middleware.
async function verifyGoogleIdToken(token) {
  const ticket = await client.verifyIdToken({
    idToken: token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload();
}

async function verifyGoogleToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  const token = authHeader.split(' ')[1];

  try {
    req.user = await verifyGoogleIdToken(token); // gán thông tin user vào req
    next();
  } catch (error) {
    console.error('Token verification failed:', error);
    return res.status(403).json({ error: 'Invalid token' });
  }
}

module.exports = verifyGoogleToken;
module.exports.verifyGoogleIdToken = verifyGoogleIdToken;
