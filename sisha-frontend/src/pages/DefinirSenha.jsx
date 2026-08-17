import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE_URL, LOGIN_NOTICE_KEY } from '../lib/api';

function readAccessToken() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  return hash.get('access_token') || query.get('access_token') || '';
}

function readLinkError() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  return hash.get('error_description') || query.get('error_description') || '';
}

export default function DefinirSenha() {
  const navigate = useNavigate();
  const token = useMemo(() => readAccessToken(), []);
  const initialError = useMemo(() => readLinkError(), []);
  const [senha, setSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState(initialError ? decodeURIComponent(initialError) : '');

  useEffect(() => {
    // Remove token/erro da barra de endereços assim que a tela os captura.
    window.history.replaceState({}, document.title, '/definir-senha');
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setMensagem('');

    if (!token) {
      setMensagem('Link de acesso inválido ou expirado. Volte ao login e solicite um novo link.');
      return;
    }
    if (!senha) {
      setMensagem('Informe a nova senha.');
      return;
    }
    if (senha !== confirmacao) {
      setMensagem('As senhas digitadas não coincidem.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/auth/password/set`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ senha }),
      });
      const result = await response.json();
      if (!response.ok || result.status !== 'success') {
        throw new Error(result.message || 'Falha ao definir a senha.');
      }

      try {
        sessionStorage.setItem(LOGIN_NOTICE_KEY, result.message || 'Senha definida com sucesso. Faça login.');
      } catch {
        // Ignora storage indisponível.
      }
      navigate('/login', { replace: true });
    } catch (error) {
      setMensagem(error.message || 'Falha ao definir a senha. Solicite um novo link.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-black text-white flex items-center justify-center px-4 py-6 sm:px-6 sm:py-10 bg-[url('/brasao.png')] bg-no-repeat bg-center bg-[length:68%] sm:bg-[length:42%] lg:bg-[length:30%]">
      <div className="absolute inset-0 bg-black/70" />

      <div className="relative z-10 w-full max-w-md rounded-3xl bg-black/80 p-6 sm:p-10 text-center shadow-2xl border border-white/10 backdrop-blur-[2px]">
        <img src="/brasao.png" alt="Brasão" className="w-24 sm:w-32 lg:w-36 mx-auto mb-5 sm:mb-6 select-none" />
        <h1 className="text-base sm:text-xl font-black tracking-[0.16em] sm:tracking-wider uppercase leading-tight mb-2">
          Definir senha de acesso
        </h1>
        <p className="text-sm text-slate-300 mb-6">A senha é pessoal e não é definida pelo Admin ou pelo Dono.</p>

        <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5 text-left">
          <div>
            <label className="block mb-2 font-bold text-sm sm:text-base">Nova senha</label>
            <input
              type="password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              required
              autoComplete="new-password"
              className="w-full rounded-xl border border-blue-600 bg-white text-slate-900 px-4 py-3.5 sm:py-3 outline-none text-base"
            />
          </div>

          <div>
            <label className="block mb-2 font-bold text-sm sm:text-base">Confirmar nova senha</label>
            <input
              type="password"
              value={confirmacao}
              onChange={(e) => setConfirmacao(e.target.value)}
              required
              autoComplete="new-password"
              className="w-full rounded-xl border border-blue-600 bg-white text-slate-900 px-4 py-3.5 sm:py-3 outline-none text-base"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !token}
            className="w-full rounded-xl bg-blue-600 hover:bg-blue-700 transition-all py-3.5 sm:py-3 font-black uppercase tracking-wide disabled:opacity-60 text-sm sm:text-base"
          >
            {loading ? 'Salvando...' : 'Definir senha'}
          </button>

          <button
            type="button"
            onClick={() => navigate('/login', { replace: true })}
            className="w-full text-center text-sm font-bold text-blue-300 hover:text-blue-200"
          >
            Voltar ao login
          </button>

          <p className="text-amber-300 text-sm min-h-[1.5rem] text-center leading-relaxed px-1">{mensagem}</p>
        </form>
      </div>
    </div>
  );
}
