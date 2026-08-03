import { useNavigate } from 'react-router'
import { Check, Sparkles, Zap, ArrowLeft } from 'lucide-react'

const STARTER_FEATURES = [
  'Play unlimited games',
  'Submit scores to global leaderboard',
  'Access to 5,000+ questions',
  'All question categories',
]

const PRO_FEATURES = [
  'Everything in Starter',
  'Create and add custom questions',
  'Questions reviewed & published globally',
  'Priority support',
  'More features coming soon',
]

function FeatureRow({ text, included = true }: { text: string; included?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '6px 0',
      }}
    >
      <div
        style={{
          width: '20px',
          height: '20px',
          borderRadius: '50%',
          background: included ? '#F0FDF4' : '#F1F5F9',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          marginTop: '1px',
        }}
      >
        <Check size={11} color={included ? '#15803D' : '#94A3B8'} strokeWidth={3} />
      </div>
      <span
        style={{
          fontSize: '14px',
          fontWeight: 500,
          color: included ? '#374151' : '#9CA3AF',
          lineHeight: 1.5,
        }}
      >
        {text}
      </span>
    </div>
  )
}

export function Pricing() {
  const navigate = useNavigate()

  return (
    <div
      style={{
        minHeight: 'calc(100vh - 64px)',
        background: '#F8FAFC',
        padding: '56px 24px 80px',
      }}
    >
      <div style={{ maxWidth: '960px', margin: '0 auto' }}>
        {/* Back Link */}
        <button
          onClick={() => navigate('/')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            background: 'none',
            border: 'none',
            fontSize: '14px',
            fontWeight: 500,
            color: '#64748B',
            cursor: 'pointer',
            padding: '4px 0',
            marginBottom: '40px',
            fontFamily: 'Inter, sans-serif',
            transition: 'color 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#4F46E5')}
          onMouseLeave={(e) => (e.currentTarget.style.color = '#64748B')}
        >
          <ArrowLeft size={15} />
          Back to game
        </button>

        {/* Page Header */}
        <div style={{ textAlign: 'center', marginBottom: '56px' }}>
          <h1
            style={{
              fontSize: '42px',
              fontWeight: 800,
              color: '#0F172A',
              margin: '0 0 12px',
              letterSpacing: '-1px',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            Pricing
          </h1>
          <p
            style={{
              fontSize: '17px',
              color: '#64748B',
              margin: 0,
              maxWidth: '440px',
              marginLeft: 'auto',
              marginRight: 'auto',
              lineHeight: 1.6,
            }}
          >
            Play free forever, or go Pro to contribute your own questions.
          </p>
        </div>

        {/* Cards Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '24px',
            alignItems: 'stretch',
          }}
        >
          {/* Starter Card */}
          <div
            style={{
              background: '#FFFFFF',
              borderRadius: '24px',
              border: '1px solid rgba(15,23,42,0.08)',
              boxShadow: '0 4px 24px rgba(15,23,42,0.06)',
              padding: '40px',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Card Header */}
            <div style={{ marginBottom: '32px' }}>
              <div
                style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '14px',
                  background: '#F1F5F9',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '20px',
                }}
              >
                <Zap size={22} color="#64748B" />
              </div>

              <h2
                style={{
                  fontSize: '22px',
                  fontWeight: 800,
                  color: '#0F172A',
                  margin: '0 0 6px',
                  fontFamily: 'Inter, sans-serif',
                  letterSpacing: '-0.3px',
                }}
              >
                Starter
              </h2>
              <p style={{ fontSize: '14px', color: '#64748B', margin: '0 0 24px' }}>
                Everything you need to play and compete.
              </p>

              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span
                  style={{
                    fontSize: '48px',
                    fontWeight: 800,
                    color: '#0F172A',
                    letterSpacing: '-2px',
                    fontFamily: 'Inter, sans-serif',
                    lineHeight: 1,
                  }}
                >
                  $0
                </span>
                <span style={{ fontSize: '15px', color: '#94A3B8', fontWeight: 500 }}>/month</span>
              </div>
            </div>

            {/* Divider */}
            <div style={{ height: '1px', background: 'rgba(15,23,42,0.06)', marginBottom: '28px' }} />

            {/* Features */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '32px' }}>
              {STARTER_FEATURES.map((f) => (
                <FeatureRow key={f} text={f} included={true} />
              ))}
            </div>

            {/* CTA */}
            <button
              style={{
                width: '100%',
                padding: '14px 24px',
                borderRadius: '12px',
                background: 'transparent',
                color: '#0F172A',
                border: '1.5px solid rgba(15,23,42,0.2)',
                fontSize: '15px',
                fontWeight: 700,
                cursor: 'default',
                fontFamily: 'Inter, sans-serif',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                opacity: 0.8,
              }}
            >
              <Check size={16} strokeWidth={2.5} />
              Your current plan
            </button>
          </div>

          {/* Pro Card */}
          <div
            style={{
              background: '#FFFFFF',
              borderRadius: '24px',
              border: '2px solid #4F46E5',
              boxShadow: '0 8px 40px rgba(79,70,229,0.18), 0 4px 16px rgba(79,70,229,0.1)',
              padding: '40px',
              display: 'flex',
              flexDirection: 'column',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* Subtle gradient top accent */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: '4px',
                background: 'linear-gradient(90deg, #4F46E5, #7C3AED)',
              }}
            />

            {/* PRO Badge */}
            <div
              style={{
                position: 'absolute',
                top: '20px',
                right: '20px',
                background: '#4F46E5',
                color: '#FFFFFF',
                fontSize: '11px',
                fontWeight: 800,
                padding: '4px 10px',
                borderRadius: '999px',
                letterSpacing: '0.8px',
              }}
            >
              PRO
            </div>

            {/* Card Header */}
            <div style={{ marginBottom: '32px' }}>
              <div
                style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '14px',
                  background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '20px',
                  boxShadow: '0 6px 16px rgba(79,70,229,0.3)',
                }}
              >
                <Sparkles size={22} color="#fff" />
              </div>

              <h2
                style={{
                  fontSize: '22px',
                  fontWeight: 800,
                  color: '#0F172A',
                  margin: '0 0 6px',
                  fontFamily: 'Inter, sans-serif',
                  letterSpacing: '-0.3px',
                }}
              >
                Pro
              </h2>
              <p style={{ fontSize: '14px', color: '#64748B', margin: '0 0 24px' }}>
                Contribute questions and shape the game.
              </p>

              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span
                  style={{
                    fontSize: '48px',
                    fontWeight: 800,
                    color: '#4F46E5',
                    letterSpacing: '-2px',
                    fontFamily: 'Inter, sans-serif',
                    lineHeight: 1,
                  }}
                >
                  $0.99
                </span>
                <span style={{ fontSize: '15px', color: '#94A3B8', fontWeight: 500 }}>/month</span>
              </div>
            </div>

            {/* Divider */}
            <div style={{ height: '1px', background: 'rgba(79,70,229,0.1)', marginBottom: '28px' }} />

            {/* Features */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '32px' }}>
              {PRO_FEATURES.map((f) => (
                <FeatureRow key={f} text={f} included={true} />
              ))}
            </div>

            {/* CTA */}
            <button
              style={{
                width: '100%',
                padding: '14px 24px',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
                color: '#FFFFFF',
                border: 'none',
                fontSize: '15px',
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: 'Inter, sans-serif',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                boxShadow: '0 4px 16px rgba(79,70,229,0.35)',
                transition: 'box-shadow 0.2s, transform 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = '0 8px 28px rgba(79,70,229,0.5)'
                e.currentTarget.style.transform = 'translateY(-1px)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = '0 4px 16px rgba(79,70,229,0.35)'
                e.currentTarget.style.transform = 'translateY(0)'
              }}
            >
              <Sparkles size={16} />
              Subscribe — $0.99/mo
            </button>
          </div>
        </div>

        {/* Footer Note */}
        <p
          style={{
            textAlign: 'center',
            fontSize: '13px',
            color: '#94A3B8',
            marginTop: '40px',
          }}
        >
          Cancel anytime. No hidden fees. Questions submitted are reviewed before publishing.
        </p>
      </div>

      {/* Responsive styles */}
      <style>{`
        @media (max-width: 640px) {
          .pricing-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  )
}
