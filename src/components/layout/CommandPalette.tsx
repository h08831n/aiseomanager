import React, { useState, useEffect } from 'react';
import {
  Search,
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
  Play,
  ArrowRight,
  X,
} from 'lucide-react';
import { SaaSTabId } from './Sidebar';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTab: (tab: SaaSTabId) => void;
  onRunDailyLoop: () => void;
  onOpenCopilot: () => void;
  websites: Array<{ id: string; domain: string }>;
  onSelectWebsite: (siteId: string) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onSelectTab,
  onRunDailyLoop,
  onOpenCopilot,
  websites,
  onSelectWebsite,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (isOpen) onClose();
      }
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const allItems = [
    {
      category: 'NAVIGATION',
      items: [
        { label: 'Autonomous SEO Optimization Engine', icon: Sparkles, action: () => { onSelectTab('seo-engine'); onClose(); } },
        { label: 'Go to Dashboard Overview', icon: LayoutDashboard, action: () => { onSelectTab('dashboard'); onClose(); } },
        { label: 'Go to SEO Health (17 Pillars)', icon: Activity, action: () => { onSelectTab('health'); onClose(); } },
        { label: 'Go to AI Recommendations Queue', icon: Sparkles, action: () => { onSelectTab('recommendations'); onClose(); } },
        { label: 'Go to Action Timeline & Rollbacks', icon: Zap, action: () => { onSelectTab('actions'); onClose(); } },
        { label: 'Go to Keyword Universe & SERPs', icon: TrendingUp, action: () => { onSelectTab('keywords'); onClose(); } },
        { label: 'Go to Analytics (GSC / GA4)', icon: BarChart3, action: () => { onSelectTab('analytics'); onClose(); } },
        { label: 'Go to Competitor Gap Matrix', icon: ShieldAlert, action: () => { onSelectTab('competitors'); onClose(); } },
        { label: 'Go to Integrations Hub', icon: Boxes, action: () => { onSelectTab('integrations'); onClose(); } },
        { label: 'Go to Settings & Safety Limits', icon: Settings, action: () => { onSelectTab('settings'); onClose(); } },
      ],
    },
    {
      category: 'QUICK ACTIONS & AI',
      items: [
        { label: 'Execute Daily Autonomous SEO Loop (42 Steps)', icon: Play, action: () => { onRunDailyLoop(); onClose(); } },
        { label: 'Open AI Copilot Dialog', icon: Bot, action: () => { onOpenCopilot(); onClose(); } },
      ],
    },
    {
      category: 'DOMAINS & SITES',
      items: websites.map((site) => ({
        label: `Switch site: ${site.domain}`,
        icon: Globe,
        action: () => { onSelectWebsite(site.id); onClose(); },
      })),
    },
  ];

  const filteredSections = allItems
    .map((sec) => ({
      ...sec,
      items: sec.items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
    }))
    .filter((sec) => sec.items.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-xl rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
        {/* Search Header */}
        <div className="flex items-center px-4 py-3.5 border-b border-slate-800 bg-slate-950/60">
          <Search className="w-4 h-4 text-slate-400 shrink-0 mr-3" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Type a command, page name, or domain..."
            className="w-full bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none font-sans"
          />
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-500 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {filteredSections.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 font-mono">
              No matching commands or pages found for "{query}"
            </div>
          ) : (
            filteredSections.map((sec, sIdx) => (
              <div key={sIdx} className="space-y-1">
                <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 font-mono">
                  {sec.category}
                </div>
                {sec.items.map((item, iIdx) => {
                  const Icon = item.icon;
                  return (
                    <div
                      key={iIdx}
                      onClick={item.action}
                      className="flex items-center justify-between px-3 py-2 rounded-xl text-xs text-slate-300 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center space-x-2.5">
                        <div className="p-1 rounded bg-slate-800/80 text-emerald-400 border border-slate-700/50">
                          <Icon className="w-3.5 h-3.5" />
                        </div>
                        <span className="font-medium">{item.label}</span>
                      </div>
                      <ArrowRight className="w-3 h-3 text-slate-600" />
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between text-[11px] text-slate-500 font-mono">
          <div className="flex items-center space-x-3">
            <span>↑↓ Navigate</span>
            <span>↵ Select</span>
            <span>ESC Close</span>
          </div>
          <span>AI SEO SaaS Command Core</span>
        </div>
      </div>
    </div>
  );
};
