import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    setErro('');
    setLoading(true);

    try {
      const response = await fetch('http://localhost:3000/api/auth/login', {
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

  return (
    <div className="min-h-screen bg-black text-white bg-[url('/brasao.png')] bg-no-repeat bg-center bg-[length:30%] flex items-center justify-center px-4">
      <div className="fixed inset-0 bg-black/70 -z-10" />

      <div className="w-full max-w-md bg-black/80 rounded-2xl p-10 text-center shadow-2xl">
        <img src="/brasao.png" alt="Brasão" className="w-36 mx-auto mb-6" />
        <h1 className="text-xl font-black tracking-wider uppercase mb-8">Invenire Hostem et Delere</h1>

        <form onSubmit={handleSubmit} className="space-y-5 text-left">
          <div>
            <label className="block mb-2 font-bold">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-lg border border-blue-600 bg-white text-slate-900 px-4 py-3 outline-none"
            />
          </div>

          <div>
            <label className="block mb-2 font-bold">Senha</label>
            <input
              type="password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              required
              className="w-full rounded-lg border border-blue-600 bg-white text-slate-900 px-4 py-3 outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 transition-all py-3 font-black uppercase disabled:opacity-60"
          >
            {loading ? 'Verificando...' : 'Entrar'}
          </button>

          <p className="text-amber-300 text-sm min-h-6 text-center">{erro}</p>
        </form>
      </div>
    </div>
  );
}
