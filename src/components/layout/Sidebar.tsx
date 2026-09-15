import React from 'react';
import {
  LayoutDashboard,
  Globe,
  Activity,
  Sparkles,
  Zap,
  TrendingUp,
  BarChart3,
  ShieldAlert,
  Boxes,
  Bot,
  Settings,
  CreditCard,
  ChevronRight,
  Server,
  Layers,
  FileCheck,
  Cpu,
  Shield,
  Sliders,
  Users,
} from 'lucide-react';

export type SaaSTabId =
  | 'seo-engine'
  | 'dashboard'
  | 'agents'
  | 'decisions'
  | 'actions'
  | 'analytics'
  | 'health'
  | 'keywords'
  | 'competitors'
  | 'projects'
  | 'integrations'
  | 'autonomy'
  | 'copilot'
  | 'settings'
  | 'recommendations'; // alias for backward-compat

interface SidebarProps {
  currentTab: SaaSTabId;
  onSelectTab: (tab: SaaSTabId) => void;
  recommendationsCount?: number;
  activeActionsCount?: number;
  seoScore?: number;
  observabilityStatus?: { db: string; redis: string; worker: string };
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  recommendationsCount = 0,
  activeActionsCount = 0,
  seoScore = 88,
  observabilityStatus = { db: 'UP', redis: 'UP', worker: 'UP' },
}) => {
  const navSections = [
    {
      title: 'AUTONOMOUS SEO ENGINE',
      items: [
        { id: 'seo-engine' as SaaSTabId, label: 'SEO Engine Command', icon: Cpu, badge: 'Active', badgeColor: 'bg-emerald-500/20 text-emerald-300' },
        { id: 'dashboard' as SaaSTabId, label: 'Dashboard Overview', icon: LayoutDashboard },
        { id: 'agents' as SaaSTabId, label: 'AI Strategist & Agents', icon: Users, badge: '6 Active', badgeColor: 'bg-cyan-500/20 text-cyan-300' },
        { id: 'decisions' as SaaSTabId, label: 'Strategic Tasks', icon: Sparkles, badge: recommendationsCount > 0 ? String(recommendationsCount) : undefined, badgeColor: 'bg-indigo-500/20 text-indigo-300' },
        { id: 'actions' as SaaSTabId, label: 'Execution & Verification', icon: Zap, badge: activeActionsCount > 0 ? String(activeActionsCount) : undefined, badgeColor: 'bg-emerald-500/20 text-emerald-300' },
      ],
    },
    {
      title: 'SEO INTELLIGENCE',
      items: [
        { id: 'health' as SaaSTabId, label: '6-Pillar Health Score', icon: Activity, badge: `${seoScore}%` },
        { id: 'keywords' as SaaSTabId, label: 'Keywords & Intent', icon: TrendingUp },
        { id: 'competitors' as SaaSTabId, label: 'Competitor Gaps', icon: ShieldAlert },
        { id: 'analytics' as SaaSTabId, label: 'Attribution & Metrics', icon: BarChart3 },
      ],
    },
    {
      title: 'PLATFORM & SYSTEM',
      items: [
        { id: 'projects' as SaaSTabId, label: 'Target Websites', icon: Globe },
        { id: 'integrations' as SaaSTabId, label: 'WordPress & CMS', icon: Boxes },
        { id: 'autonomy' as SaaSTabId, label: 'Autonomy Controls', icon: Sliders, badge: 'Autonomous', badgeColor: 'bg-emerald-500/10 text-emerald-400' },
        { id: 'copilot' as SaaSTabId, label: 'AI SEO Assistant', icon: Bot, badge: 'Gemini 3.7', badgeColor: 'bg-cyan-500/20 text-cyan-300' },
        { id: 'settings' as SaaSTabId, label: 'Settings', icon: Settings },
      ],
    },
  ];

  const isAllSystemsUp = observabilityStatus.db === 'UP' && observabilityStatus.worker === 'UP';

  return (
    <aside className="w-64 flex flex-col bg-slate-950 border-r border-slate-800/80 select-none shrink-0 h-screen sticky top-0">
      {/* Brand Header */}
      <div className="p-4 border-b border-slate-800/80 flex items-center justify-between">
        <div className="flex items-center space-x-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 flex items-center justify-center text-white shadow-md shadow-emerald-950/50">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center space-x-1.5">
              <span className="font-bold text-sm text-white tracking-tight">AI SEO Manager</span>
              <span className="text-[10px] font-mono font-semibold px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                v3.2
              </span>
            </div>
            <p className="text-[11px] text-slate-500">Autonomous Virtual Team</p>
          </div>
        </div>
      </div>

      {/* Navigation Sections */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-5 scrollbar-thin">
        {navSections.map((section, idx) => (
          <div key={idx} className="space-y-1">
            <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 font-mono">
              {section.title}
            </div>

            {section.items.map((item) => {
              const Icon = item.icon;
              const isActive =
                currentTab === item.id ||
                (item.id === 'decisions' && currentTab === 'recommendations');

              return (
                <button
                  key={item.id}
                  id={`sidebar-tab-${item.id}`}
                  onClick={() => onSelectTab(item.id)}
                  className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-medium transition-all duration-150 cursor-pointer ${
                    isActive
                      ? 'bg-slate-800/90 text-white font-semibold shadow-sm border border-slate-700/80'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/80'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Icon
                      className={`w-4 h-4 transition-colors ${
                        isActive ? 'text-emerald-400' : 'text-slate-400'
                      }`}
                    />
                    <span>{item.label}</span>
                  </div>

                  <div className="flex items-center space-x-1.5">
                    {item.badge && (
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-semibold ${
                          item.badgeColor || (isActive ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400')
                        }`}
                      >
                        {item.badge}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* System Status & Engine Footer */}
      <div className="p-3 border-t border-slate-800/80 bg-slate-950/80 space-y-2">
        <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 flex items-center justify-between text-[11px]">
          <div className="flex items-center space-x-2">
            <div className={`w-2 h-2 rounded-full ${isAllSystemsUp ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
            <span className="text-slate-300 font-medium font-mono">
              {isAllSystemsUp ? 'Autonomous Swarm Active' : 'Swarm Degradation'}
            </span>
          </div>
          <span className="text-[10px] text-slate-500 font-mono">24/7 Loop</span>
        </div>
      </div>
    </aside>
  );
};
