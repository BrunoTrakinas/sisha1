// src/config/supabaseClient.js
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const dotenv = require('dotenv');

// Caminho absoluto para o .env (sobe de config -> src -> raiz do backend)
const envPath = path.join(__dirname, '..', '..', '.env');
dotenv.config({ path: envPath });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// Log de depuração (ajuda a gente a ver se o valor carregou)
if (!supabaseUrl) {
    console.error('❌ ERRO: SUPABASE_URL não encontrada no .env');
    console.log('📍 Procurando em:', envPath);
} else {
    console.log('🔗 Conectando ao Supabase em:', supabaseUrl);
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');

module.exports = supabase;