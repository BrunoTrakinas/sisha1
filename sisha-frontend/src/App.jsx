import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation, Navigate } from 'react-router-dom';
import {
  LayoutDashboard, PackageSearch, PenTool, Calculator, ShoppingCart,
  Sun, Moon, LogOut, FileUp, AlertTriangle, Database, FileText, Menu, Bot, History
} from 'lucide-react';
import Cadastro from './pages/Cadastro';
import ConsultaItens from './pages/ConsultaItens';
import GeradorNecessidades from './pages/GeradorNecessidades';
import CustoOperacional from './pages/CustoOperacional';
import ServiceBulletins from './pages/ServiceBulletins';
import OrdensCompras from './pages/OrdensCompras';
import ChatLince from './pages/ChatLince';
import HistoricoMovimentacao from './pages/HistoricoMovimentacao';
import Login from './pages/Login';
import ProtectedRoute from './components/ProtectedRoute';
import { AuthProvider, useAuth } from './context/AuthContext';
import { apiFetch } from './lib/api';

const formatDateTime = (value) => {
  if (!value) return '—';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleString('pt-BR');
};

const CardStatus = ({ title, value, secondaryValue, secondaryLabel, color, icon: Icon, unitLabel = 'Unidades' }) => (
  <div className={`bg-white dark:bg-slate-800 p-6 rounded-3xl border-b-8 ${color} shadow-lg border-gray-200 dark:border-slate-700 transition-all hover:translate-y-[-4px]`}>
    <div className="flex justify-between items-start gap-4">
      <div className="flex-1 min-w-0">
        <h4 className="text-[11px] uppercase tracking-[0.2em] font-black text-gray-400 dark:text-gray-500 mb-1">{title}</h4>
        <div className="flex items-baseline gap-2 flex-wrap">
          <p className="text-[clamp(1rem,1.2vw,1.8rem)] font-black text-slate-800 dark:text-white whitespace-nowrap leading-none">{value}</p>
          {unitLabel ? <span className="text-xs font-bold text-slate-400 uppercase tracking-tighter">{unitLabel}</span> : null}
        </div>
        {secondaryValue !== undefined && (
          <div className="mt-4 pt-4 border-t border-gray-100 dark:border-slate-700/50">
            <span className="inline-flex items-center text-sm font-black px-4 py-2 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-xl shadow-sm">
              {secondaryValue} {secondaryLabel}
            </span>
          </div>
        )}
      </div>
      <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/50 text-slate-400 shrink-0">
        <Icon size={28} />
      </div>
    </div>
  </div>
);

const OdcPipelineCard = ({ loading, pipeline = {} }) => {
  const aguardandoRecursos = Number(pipeline.aguardandoRecursos || 0);
  const chips = [
    ['ELB', pipeline.elaboracao || 0, 'Elaboração'],
    ['TRI/ANS', pipeline.triagemAnalise || 0, 'Triagem/Análise'],
    ['COT/PRO', pipeline.cotacao || 0, 'Cotação'],
    ['LIB/LPC', pipeline.liberadaCotacao || 0, 'Liberado cotação'],
    ['ODC', pipeline.odc || 0, 'OC gerada'],
  ];

  return (
    <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border-b-8 border-amber-500 shadow-lg border-gray-200 dark:border-slate-700 transition-all hover:translate-y-[-4px]">
      <div className="flex justify-between items-start gap-4">
        <div className="flex-1 min-w-0">
          <h4 className="text-[11px] uppercase tracking-[0.2em] font-black text-gray-400 dark:text-gray-500 mb-1">PD AGU REC</h4>
          <div className="flex items-baseline gap-2 flex-wrap">
            <p className="text-[clamp(1rem,1.2vw,1.8rem)] font-black text-slate-800 dark:text-white whitespace-nowrap leading-none">
              {loading ? '...' : aguardandoRecursos.toLocaleString('pt-BR')}
            </p>
            <span className="text-xs font-bold text-slate-400 uppercase tracking-tighter">PDs aguardando recursos</span>
          </div>
          <p className="mt-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            Não inclui ODA, EMB, REC, FAT ou CAN
          </p>
          <div className="mt-4 pt-4 border-t border-gray-100 dark:border-slate-700/50 grid grid-cols-2 gap-2">
            {chips.map(([sigla, valor, label]) => (
              <div key={sigla} className="rounded-xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-700 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-black text-slate-400 uppercase">{sigla}</span>
                  <span className="text-sm font-black text-blue-600 dark:text-blue-400">{loading ? '...' : Number(valor || 0).toLocaleString('pt-BR')}</span>
                </div>
                <p className="text-[9px] font-bold text-slate-400 uppercase truncate">{label}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/50 text-slate-400 shrink-0">
          <AlertTriangle size={28} />
        </div>
      </div>
    </div>
  );
};

const DashboardLayout = ({ children }) => {
  const [darkMode, setDarkMode] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const { user, logout } = useAuth();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const allMenuItems = [
    { path: '/', icon: LayoutDashboard, label: 'Visão Geral', roles: ['dono', 'admin', 'operador'] },
    { path: '/consulta', icon: PackageSearch, label: 'Consulta de Itens', roles: ['dono', 'admin', 'operador'] },
    { path: '/cadastro', icon: Database, label: 'Central de Inserção', roles: ['dono', 'admin'] },
    { path: '/sb', icon: FileText, label: 'Service Bulletin', roles: ['dono', 'admin'] },
    { path: '/gerador', icon: PenTool, label: 'Gerador de Necessidades', roles: ['dono', 'admin', 'operador'] },
    { path: '/custo', icon: Calculator, label: 'Custo Operacional', roles: ['dono', 'admin', 'operador'] },
    { path: '/compras', icon: ShoppingCart, label: 'Ordens de Compras', roles: ['dono', 'admin', 'operador'] },
    { path: '/historico-movimentacao', icon: History, label: 'Histórico de Movimentação', roles: ['dono', 'admin', 'operador'] },
    { path: '/chat-lince', icon: Bot, label: 'Chat Lince', roles: ['dono', 'admin', 'operador'] },
  ];

  const menuItems = allMenuItems.filter(item => item.roles.includes(user?.role || 'operador'));

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors duration-300">
      {menuOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-slate-900 border-r border-slate-800 flex flex-col shadow-xl transform transition-transform duration-300 ease-out lg:static lg:translate-x-0 ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="p-8 flex flex-col items-center">
          <div className="relative p-1 bg-white rounded-full shadow-lg mb-4">
            <img src="/icon.png" alt="SISHA-1" className="w-20 h-20 object-contain" />
          </div>
          <h1 className="text-white font-black text-lg tracking-tighter">SISHA-1</h1>
          <div className="flex items-center gap-2 mt-1 max-w-full px-2">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse shrink-0"></span>
            <p className="text-[10px] uppercase font-bold text-slate-400 tracking-widest truncate">
              {user?.role === 'dono' ? 'Dono' : user?.role === 'admin' ? 'Admin' : 'Operador'} • {user?.email || '---'}
            </p>
          </div>
        </div>

        <nav className="flex-1 px-4 space-y-1 overflow-y-auto">
          {menuItems.map((item) => {
            const isActive = location.pathname === item.path;
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={() => setMenuOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${
                  isActive ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
                }`}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 bg-slate-950/50">
          <button
            onClick={logout}
            className="flex items-center gap-3 px-4 py-3 w-full text-red-400 hover:bg-red-900/20 rounded-xl font-bold transition-all"
          >
            <LogOut size={18} />
            <span>Sair</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-20 flex items-center justify-between px-4 sm:px-6 lg:px-8 bg-white/80 dark:bg-slate-900/50 backdrop-blur-md border-b border-gray-200 dark:border-slate-800">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMenuOpen(true)}
              className="lg:hidden p-2 rounded-xl bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-100 shadow-inner shrink-0"
              aria-label="Abrir menu"
            >
              <Menu size={20} />
            </button>

            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl lg:text-2xl font-black tracking-tight uppercase truncate">
                {menuItems.find(m => m.path === location.pathname)?.label || 'Painel'}
              </h2>
              <p className="text-[10px] sm:text-xs text-gray-500 font-medium truncate">
                Sistema de Inteligência e Histórico de Aeronaves
              </p>
            </div>
          </div>

          <button
            onClick={() => setDarkMode(!darkMode)}
            className="p-3 rounded-2xl bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-yellow-400 hover:scale-110 transition-all shadow-inner shrink-0"
          >
            {darkMode ? <Sun size={20} fill="currentColor" /> : <Moon size={20} fill="currentColor" />}
          </button>
        </header>

        <div className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 bg-gray-50/50 dark:bg-transparent">
          {children}
        </div>
      </main>
    </div>
  );
};

const VisaoGeral = () => {
  const { user, token } = useAuth();
  const [stats, setStats] = useState({
    totalPPU: 0,
    totalPPU_PNs: 0,
    totalODA: 0,
    totalODA_PDs: 0,
    totalODC: 0,
    totalODC_PDs: 0,
    odcPipeline: {},
    orcamento: '£0.00',
    pnsPrecificados: 0,
    moeda: 'GBP',
  });
  const [radar, setRadar] = useState([]);
  const [operations, setOperations] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const isDono = Boolean(user?.isDono) || Boolean(user?.isGod) || user?.role === 'dono';

  useEffect(() => {
    const fetchDashboard = async () => {
      try {
        const [statsRes, radarRes, operationsRes] = await Promise.all([
          apiFetch('/stats/dashboard', {}, token),
          apiFetch('/stats/radar', {}, token),
          apiFetch('/stats/operations', {}, token),
        ]);

        const [statsJson, radarJson, operationsJson] = await Promise.all([
          statsRes.json(),
          radarRes.json(),
          operationsRes.json(),
        ]);

        if (statsJson.status === 'success') setStats(statsJson.data);
        if (radarJson.status === 'success') setRadar(radarJson.data || []);
        if (operationsJson.status === 'success') setOperations(operationsJson.data || []);

        if (isDono) {
          const onlineRes = await apiFetch('/auth/online', {}, token);
          const onlineJson = await onlineRes.json();
          if (onlineJson.status === 'success') setOnlineUsers(onlineJson.data || []);
        } else {
          setOnlineUsers([]);
        }
      } catch (error) {
        console.error('Erro ao carregar visão geral:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchDashboard();
    const interval = setInterval(fetchDashboard, 30000);
    return () => clearInterval(interval);
  }, [token, isDono]);

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <CardStatus
          title="Estoque PPU"
          value={loading ? '...' : Number(stats.totalPPU || 0).toLocaleString('pt-BR')}
          secondaryValue={stats.totalPPU_PNs}
          secondaryLabel="PNs Diferentes"
          color="border-blue-600"
          icon={PackageSearch}
        />
        <CardStatus
          title="ODA Leonardo"
          value={loading ? '...' : Number(stats.totalODA || 0).toLocaleString('pt-BR')}
          secondaryValue={stats.totalODA_PDs}
          secondaryLabel="PDs em Aberto"
          color="border-indigo-600"
          icon={FileUp}
        />
        <OdcPipelineCard
          loading={loading}
          pipeline={stats.odcPipeline || {}}
        />
        <CardStatus
          title="Estoque Valorizado"
          value={loading ? '...' : (stats.orcamento || '£0.00')}
          secondaryValue={stats.pnsPrecificados}
          secondaryLabel="PNs Precificados"
          color="border-green-500"
          icon={Calculator}
          unitLabel=""
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="bg-white dark:bg-slate-800 rounded-3xl border border-gray-200 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col transition-all hover:shadow-md">
          <div className="p-6 border-b border-gray-200 dark:border-slate-700 bg-red-50/50 dark:bg-red-900/10">
            <h3 className="font-black text-xs uppercase tracking-[0.2em] text-red-600 dark:text-red-400 flex items-center gap-2">
              <AlertTriangle size={14} /> Radar de Criticidade
            </h3>
          </div>
          <div className="p-6 flex-1 space-y-4">
            {radar.length > 0 ? radar.map((item, i) => (
              <div key={`${item.tipo}-${item.pn}-${i}`} className="flex justify-between items-center gap-4 p-3 bg-slate-50 dark:bg-slate-900/50 rounded-2xl border border-slate-100 dark:border-slate-700">
                <div className="min-w-0">
                  <p className="text-sm font-black text-slate-700 dark:text-slate-200 truncate">{item.pn || 'N/A'}</p>
                  <p className="text-[10px] font-bold text-slate-400 uppercase truncate">{item.titulo}</p>
                  <p className="text-[10px] text-slate-500 truncate">{item.detalhe}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`text-xs font-black uppercase ${item.severidade === 'ALTA' ? 'text-red-600' : 'text-amber-500'}`}>{item.severidade}</p>
                  <p className="text-[10px] font-bold text-slate-400 uppercase">{item.local || 'N/A'}</p>
                </div>
              </div>
            )) : (
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-700">
                <p className="text-sm font-black text-slate-700 dark:text-slate-200">Nenhum alerta crítico ativo.</p>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-2 bg-white dark:bg-slate-800 rounded-3xl border border-gray-200 dark:border-slate-700 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-gray-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/30">
              <h3 className="font-black text-xs uppercase tracking-[0.2em] text-slate-500">Log de Operações Recentes</h3>
            </div>
            <div className="p-6 space-y-4">
              {isDono ? (
                <div className="rounded-2xl border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-900/10 p-4">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <p className="text-xs font-black uppercase tracking-[0.2em] text-green-700 dark:text-green-400">Usuários online agora</p>
                    <span className="text-xs font-black text-green-700 dark:text-green-400">{onlineUsers.length}</span>
                  </div>
                  {onlineUsers.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {onlineUsers.map((u) => (
                        <div key={u.email} className="rounded-xl bg-white dark:bg-slate-900/60 border border-green-100 dark:border-green-900/40 px-3 py-2">
                          <p className="text-sm font-black text-slate-700 dark:text-slate-200 truncate">{u.email}</p>
                          <p className="text-[10px] font-bold text-slate-400 uppercase truncate">{u.role || 'usuário'} • visto {formatDateTime(u.last_seen_at)}</p>
                          {u.last_path ? <p className="text-[10px] text-slate-400 truncate">{u.last_path}</p> : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm font-bold text-green-700 dark:text-green-300">Nenhum outro usuário online nos últimos minutos.</p>
                  )}
                </div>
              ) : null}

              {operations.length > 0 ? operations.map((op, i) => (
                <div key={`${op.tipo_arquivo}-${op.created_at}-${i}`} className="flex items-center justify-between gap-4 p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-700">
                  <div className="min-w-0">
                    <p className="font-black text-slate-700 dark:text-slate-200 truncate">{op.tipo_arquivo || 'Operação'} • {op.nome_arquivo || 'Sem arquivo'}</p>
                    <p className="text-xs text-slate-400 truncate">{op.uploaded_by_email || 'Sistema'} • {formatDateTime(op.created_at)}</p>
                    {op.mensagem ? <p className="text-[11px] text-slate-500 truncate">{op.mensagem}</p> : null}
                  </div>
                  <span className={`text-xs font-black uppercase shrink-0 ${['SUCESSO', 'INFO', 'AUDIT'].includes(String(op.status || '').toUpperCase()) ? 'text-green-600' : String(op.status || '').toUpperCase() === 'WARN' ? 'text-amber-500' : 'text-red-600'}`}>
                    {op.status || 'N/A'}
                  </span>
                </div>
              )) : (
                <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-700">
                  <p className="font-black text-slate-700 dark:text-slate-200">Ainda não há operações recentes registradas.</p>
                </div>
              )}
            </div>
          </div>
      </div>
    </div>
  );
};

function AppRoutes() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <DashboardLayout>
                <Routes>
                  <Route path="/" element={<VisaoGeral />} />
                  <Route path="/consulta" element={<ConsultaItens />} />
                  <Route path="/cadastro" element={<ProtectedRoute roles={["dono","admin"]}><Cadastro /></ProtectedRoute>} />
                  <Route path="/sb" element={<ProtectedRoute roles={["dono","admin"]}><ServiceBulletins /></ProtectedRoute>} />
                  <Route path="/gerador" element={<GeradorNecessidades />} />
                  <Route path="/custo" element={<CustoOperacional />} />
                  <Route path="/compras" element={<OrdensCompras />} />
                  <Route path="/historico-movimentacao" element={<HistoricoMovimentacao />} />
                  <Route path="/chat-lince" element={<ChatLince />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </DashboardLayout>
            </ProtectedRoute>
          }
        />
      </Routes>
    </Router>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}