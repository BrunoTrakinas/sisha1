import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { API_BASE_URL, LOGIN_NOTICE_KEY } from '../lib/api';

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    try {
      const notice = sessionStorage.getItem(LOGIN_NOTICE_KEY);
      if (notice) {
        setErro(notice);
        sessionStorage.removeItem(LOGIN_NOTICE_KEY);
      }
    } catch {
      // Ignora falhas de storage.
    }
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setErro('');
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, senha }),
      });

      const result = await response.json();

      if (result.status === 'success' && result.token) {
        login({ token: result.token, user: result.user });
        navigate('/', { replace: true });
        return;
      }

      setErro(result.message || 'Falha ao autenticar.');
    } catch {
      setErro('Erro de conexão com o servidor.');
    } finally {
      setLoading(false);
    }
  };

  const handleEsqueciSenha = async () => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setErro('Informe seu email antes de solicitar o link de acesso.');
      return;
    }

    setErro('');
    setResetLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/auth/password/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail }),
      });
      const result = await response.json();
      setErro(result.message || 'Se o email estiver autorizado, o link será enviado.');
    } catch {
      setErro('Não foi possível solicitar o link agora. Tente novamente.');
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-black text-white flex items-center justify-center px-4 py-6 sm:px-6 sm:py-10 bg-[url('/brasao.png')] bg-no-repeat bg-center bg-[length:68%] sm:bg-[length:42%] lg:bg-[length:30%]">
      <div className="absolute inset-0 bg-black/70" />

      <div className="relative z-10 w-full max-w-md rounded-3xl bg-black/80 p-6 sm:p-10 text-center shadow-2xl border border-white/10 backdrop-blur-[2px]">
        <img
          src="/brasao.png"
          alt="Brasão"
          className="w-24 sm:w-32 lg:w-36 mx-auto mb-5 sm:mb-6 select-none"
        />

        <h1 className="text-base sm:text-xl font-black tracking-[0.16em] sm:tracking-wider uppercase leading-tight mb-6 sm:mb-8">
          Invenire Hostem et Delere
        </h1>

        <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5 text-left">
          <div>
            <label className="block mb-2 font-bold text-sm sm:text-base">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full rounded-xl border border-blue-600 bg-white text-slate-900 px-4 py-3.5 sm:py-3 outline-none text-base"
            />
          </div>

          <div>
            <label className="block mb-2 font-bold text-sm sm:text-base">Senha</label>
            <input
              type="password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full rounded-xl border border-blue-600 bg-white text-slate-900 px-4 py-3.5 sm:py-3 outline-none text-base"
            />
          </div>

          <button
            type="submit"
            disabled={loading || resetLoading}
            className="w-full rounded-xl bg-blue-600 hover:bg-blue-700 transition-all py-3.5 sm:py-3 font-black uppercase tracking-wide disabled:opacity-60 text-sm sm:text-base"
          >
            {loading ? 'Verificando...' : 'Entrar'}
          </button>

          <button
            type="button"
            onClick={handleEsqueciSenha}
            disabled={loading || resetLoading}
            className="w-full text-center text-sm font-bold text-blue-300 hover:text-blue-200 disabled:opacity-60"
          >
            {resetLoading ? 'Enviando link...' : 'Esqueci minha senha'}
          </button>

          <p className="text-amber-300 text-sm min-h-[1.5rem] text-center leading-relaxed px-1">
            {erro}
          </p>
        </form>
      </div>
    </div>
  );
}
