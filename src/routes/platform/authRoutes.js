/**
 * Authentication Routes
 */

import express from 'express';
import { register, login, refreshToken } from '../../controllers/authController.js';
import { registerValidator, loginValidator, refreshTokenValidator } from '../../validators/authValidators.js';
import { validate } from '../../middleware/validation.js';

const router = express.Router();

router.post('/register', registerValidator, validate, register);
router.post('/login', loginValidator, validate, login);
router.post('/refresh', refreshTokenValidator, validate, refreshToken);

export default router;
