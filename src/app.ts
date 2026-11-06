import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pool from './config/database';

import authRoutes from './routes/auth.routes';
import documentsRoutes from './routes/documents.routes';
import templatesrRoutes from './routes/templates.routes';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/templates', templatesrRoutes);


app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'DocuFlow API funcionando',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health/db', async (_req, res) => {
  try {
    const connection = await pool.getConnection();

    try {
      await connection.query('SELECT 1');
    } finally {
      connection.release();
    }

    res.json({
      success: true,
      message: 'Conexión MySQL correcta'
    });
  } catch (error) {
    console.error('Error de conexión MySQL:', error);

    res.status(503).json({
      success: false,
      message: 'No se pudo conectar con MySQL'
    });
  }
});

export default app;