
import { Router } from 'express';
import { login, register, updateProfile } from '../controllers/auth.controller';
import { authenticateToken } from '../middlewares/auth.middleware';
import pool from '../config/database';
import type { RowDataPacket } from 'mysql2';

interface ProfileRow extends RowDataPacket {
  id: number;
  name: string;
  email: string;
}

const router = Router();

router.post('/register', register);
router.post('/login', login);

router.get('/me', authenticateToken, async (_req, res) => {
  try {
    const userId = res.locals.userId as number;

    const [users] = await pool.execute<ProfileRow[]>(
      `SELECT id, name, email
       FROM users
       WHERE id = ? AND status = 'active'
       LIMIT 1`,
      [userId]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'La cuenta no está disponible.'
      });
    }

    return res.json({
      success: true,
      user: users[0]
    });
  } catch (error) {
    console.error('Error al consultar perfil:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudo consultar el perfil.'
    });
  }
});

router.put('/me', authenticateToken, updateProfile);

export default router;