import { useState, useRef, useEffect } from 'react'
import { Link, useNavigate } from 'react-router'
import { ChevronDown, User, LogOut, PlusCircle, Save, Sparkles, X } from 'lucide-react'

export function Header() {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [displayName, setDisplayName] = useState('Jane Doe')
  const [nameInput, setNameInput] = useState('Jane Doe')
  const [saved, setSaved] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSave = () => {
    setDisplayName(nameInput)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const initials = displayName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        backgroundColor: 'rgba(255,255,255,0.82)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(15,23,42,0.08)',
      }}
    >
      <div
        style={{
          maxWidth: '1200px',
          margin: '0 auto',
          padding: '0 24px',
          height: '64px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        {/* Brand */}
        <Link
          to="/"
          style={{
            textDecoration: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Sparkles size={16} color="#fff" />
          </div>
          <span
            style={{
              fontSize: '20px',
              fontWeight: 700,
              color: '#4F46E5',
              letterSpacing: '-0.3px',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            Trivimind
          </span>
        </Link>

        {/* Right side nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <Link
            to="/pricing"
            style={{
              fontSize: '14px',
              fontWeight: 500,
              color: '#64748B',
              textDecoration: 'none',
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#0F172A')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#64748B')}
          >
            Pricing
          </Link>

          {/* Account Trigger */}
          <div style={{ position: 'relative' }} ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((o) => !o)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 12px 6px 6px',
                borderRadius: '999px',
                border: '1px solid rgba(15,23,42,0.12)',
                background: dropdownOpen ? '#F8FAFC' : '#FFFFFF',
                cursor: 'pointer',
                transition: 'background 0.15s, box-shadow 0.15s',
                boxShadow: dropdownOpen ? '0 0 0 3px rgba(79,70,229,0.12)' : 'none',
              }}
              onMouseEnter={(e) => {
                if (!dropdownOpen) (e.currentTarget.style.background = '#F8FAFC')
              }}
              onMouseLeave={(e) => {
                if (!dropdownOpen) (e.currentTarget.style.background = '#FFFFFF')
              }}
            >
              {/* Avatar */}
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#fff' }}>{initials}</span>
              </div>
              {/* Name */}
              <span style={{ fontSize: '14px', fontWeight: 500, color: '#0F172A' }}>{displayName}</span>
              {/* PRO Badge */}
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  color: '#4F46E5',
                  background: '#E0E7FF',
                  padding: '2px 6px',
                  borderRadius: '999px',
                  letterSpacing: '0.5px',
                }}
              >
                PRO
              </span>
              <ChevronDown
                size={14}
                color="#64748B"
                style={{
                  transition: 'transform 0.2s',
                  transform: dropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
              />
            </button>

            {/* Dropdown Card */}
            {dropdownOpen && (
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 'calc(100% + 8px)',
                  width: '320px',
                  background: '#FFFFFF',
                  borderRadius: '16px',
                  border: '1px solid rgba(15,23,42,0.08)',
                  boxShadow: '0 20px 40px rgba(15,23,42,0.12), 0 4px 8px rgba(15,23,42,0.06)',
                  overflow: 'hidden',
                  animation: 'fadeInDown 0.15s ease',
                }}
              >
                {/* Dropdown Header */}
                <div
                  style={{
                    padding: '16px 20px 12px',
                    borderBottom: '1px solid rgba(15,23,42,0.06)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <span style={{ fontSize: '13px', fontWeight: 600, color: '#64748B', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
                    Profile Settings
                  </span>
                  <button
                    onClick={() => setDropdownOpen(false)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', padding: '2px' }}
                  >
                    <X size={14} />
                  </button>
                </div>

                <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {/* Display Name Field */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '13px', fontWeight: 500, color: '#64748B' }}>Display Name</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="text"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        style={{
                          flex: 1,
                          padding: '8px 12px',
                          borderRadius: '8px',
                          border: '1px solid rgba(15,23,42,0.15)',
                          fontSize: '14px',
                          color: '#0F172A',
                          background: '#F8FAFC',
                          outline: 'none',
                          fontFamily: 'Inter, sans-serif',
                          transition: 'border-color 0.15s, box-shadow 0.15s',
                        }}
                        onFocus={(e) => {
                          e.currentTarget.style.borderColor = '#4F46E5'
                          e.currentTarget.style.boxShadow = '0 0 0 3px rgba(79,70,229,0.1)'
                        }}
                        onBlur={(e) => {
                          e.currentTarget.style.borderColor = 'rgba(15,23,42,0.15)'
                          e.currentTarget.style.boxShadow = 'none'
                        }}
                      />
                      <button
                        onClick={handleSave}
                        style={{
                          padding: '8px 14px',
                          borderRadius: '8px',
                          background: saved ? '#15803D' : '#4F46E5',
                          color: '#fff',
                          border: 'none',
                          fontSize: '13px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          transition: 'background 0.2s',
                          fontFamily: 'Inter, sans-serif',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <Save size={13} />
                        {saved ? 'Saved!' : 'Save'}
                      </button>
                    </div>
                  </div>

                  {/* Add Question Button */}
                  <button
                    onClick={() => { setDropdownOpen(false); navigate('/pricing') }}
                    style={{
                      width: '100%',
                      padding: '10px 16px',
                      borderRadius: '10px',
                      background: '#4F46E5',
                      color: '#fff',
                      border: 'none',
                      fontSize: '14px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      transition: 'background 0.15s',
                      fontFamily: 'Inter, sans-serif',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#4338CA')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '#4F46E5')}
                  >
                    <PlusCircle size={15} />
                    Add a question
                    <span
                      style={{
                        fontSize: '10px',
                        fontWeight: 700,
                        background: 'rgba(255,255,255,0.25)',
                        padding: '2px 6px',
                        borderRadius: '999px',
                        letterSpacing: '0.5px',
                      }}
                    >
                      PRO
                    </span>
                  </button>
                </div>

                {/* Sign Out */}
                <div style={{ padding: '0 20px 16px' }}>
                  <div style={{ height: '1px', background: 'rgba(15,23,42,0.06)', marginBottom: '12px' }} />
                  <button
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      background: 'none',
                      border: 'none',
                      fontSize: '14px',
                      fontWeight: 500,
                      color: '#B91C1C',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      transition: 'background 0.15s',
                      fontFamily: 'Inter, sans-serif',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#FEF2F2')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                  >
                    <LogOut size={14} />
                    Sign out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes fadeInDown {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </header>
  )
}
