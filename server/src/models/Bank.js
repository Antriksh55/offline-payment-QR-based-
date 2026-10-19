const mongoose = require('mongoose');

const bankSchema = new mongoose.Schema({
  name: { type: String, required: true },
  code: { type: String, required: true, unique: true, lowercase: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Bank', bankSchema);
