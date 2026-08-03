import { useState, useContext } from 'react'
import { useNavigate } from 'react-router'
import { ChevronDown, Sparkles, PlusCircle } from 'lucide-react'
import { GameContext } from './GameContext'

const QUESTION_COUNTS = ['5', '10', '15', '20']

const CATEGORIES = [
  'Any Category',
  'General Knowledge',
  'Science & Nature',
  'History',
  'Geography',
  'Art & Literature',
  'Technology',
  'Sports',
  'Mathematics',
  'Pop Culture',
]

const DIFFICULTIES = ['Any Difficulty', 'Easy', 'Medium', 'Hard']

type Source = 'open-trivia' | 'custom' | 'mixed'
const SOURCES: { label: string; value: Source }[] = [
  { label: 'Open Trivia', value: 'open-trivia' },
  { label: 'Custom', value: 'custom' },
  { label: 'Mixed', value: 'mixed' },
]

function SelectField({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: string[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label style={{ fontSize: '13px', fontWeight: 600, color: '#64748B', letterSpacing: '0.3px' }}>
        {label}
      </label>
      <div style={{ position: 'relative' }}>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: '100%',
            padding: '11px 40px 11px 14px',
            borderRadius: '10px',
            border: '1px solid rgba(15,23,42,0.15)',
            background: '#FFFFFF',
            fontSize: '14px',
            fontWeight: 500,
            color: '#0F172A',
            appearance: 'none',
            cursor: 'pointer',
            fontFamily: 'Inter, sans-serif',
            outline: 'none',
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
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <ChevronDown
          size={16}
          color="#64748B"
          style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
        />
      </div>
    </div>
  )
}

export function GameSetup() {
  const navigate = useNavigate()
  const { config, setConfig } = useContext(GameContext)

  const [numQuestions, setNumQuestions] = useState('10')
  const [category, setCategory] = useState('Any Category')
  const [difficulty, setDifficulty] = useState('Any Difficulty')
  const [source, setSource] = useState<Source>('open-trivia')
  const [starting, setStarting] = useState(false)

  const handleStart = () => {
    setStarting(true)
    setConfig({
      numQuestions: parseInt(numQuestions),
      category,
      difficulty,
      source,
    })
    setTimeout(() => navigate('/play'), 400)
  }

  return (
    <div
      style={{
        minHeight: 'calc(100vh - 64px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 16px',
        background: 'linear-gradient(145deg, #312E81 0%, #4F46E5 45%, #6D28D9 100%)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Decorative background blobs */}
      <div
        style={{
          position: 'absolute',
          top: '-80px',
          right: '-80px',
          width: '400px',
          height: '400px',
          borderRadius: '50%',
          background: 'rgba(124,58,237,0.3)',
          filter: 'blur(80px)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: '-120px',
          left: '-60px',
          width: '500px',
          height: '400px',
          borderRadius: '50%',
          background: 'rgba(67,56,202,0.4)',
          filter: 'blur(100px)',
          pointerEvents: 'none',
        }}
      />

      {/* Card */}
      <div
        style={{
          width: '100%',
          maxWidth: '480px',
          background: '#FFFFFF',
          borderRadius: '24px',
          boxShadow: '0 32px 64px rgba(15,23,42,0.22), 0 8px 16px rgba(15,23,42,0.1)',
          padding: '40px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Card Header */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '16px',
              background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
              boxShadow: '0 8px 24px rgba(79,70,229,0.35)',
            }}
          >
            <Sparkles size={24} color="#fff" />
          </div>
          <h1
            style={{
              fontSize: '28px',
              fontWeight: 800,
              color: '#4F46E5',
              margin: '0 0 8px',
              letterSpacing: '-0.5px',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            Trivimind
          </h1>
          <p style={{ fontSize: '15px', color: '#64748B', margin: 0, lineHeight: 1.5 }}>
            Configure your quiz and test your knowledge
          </p>
        </div>

        {/* Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '24px' }}>
          <SelectField
            label="Number of Questions"
            options={QUESTION_COUNTS}
            value={numQuestions}
            onChange={setNumQuestions}
          />
          <SelectField
            label="Category"
            options={CATEGORIES}
            value={category}
            onChange={setCategory}
          />
          <SelectField
            label="Difficulty"
            options={DIFFICULTIES}
            value={difficulty}
            onChange={setDifficulty}
          />

          {/* Source Segment Control */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '13px', fontWeight: 600, color: '#64748B', letterSpacing: '0.3px' }}>
              Question Source
            </label>
            <div
              style={{
                display: 'flex',
                background: '#F1F5F9',
                borderRadius: '10px',
                padding: '4px',
                gap: '2px',
              }}
            >
              {SOURCES.map(({ label, value }) => (
                <button
                  key={value}
                  onClick={() => setSource(value)}
                  style={{
                    flex: 1,
                    padding: '9px 8px',
                    borderRadius: '8px',
                    border: 'none',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'background 0.2s, color 0.2s, box-shadow 0.2s',
                    fontFamily: 'Inter, sans-serif',
                    background: source === value ? '#E0E7FF' : 'transparent',
                    color: source === value ? '#4F46E5' : '#64748B',
                    boxShadow: source === value ? '0 1px 3px rgba(79,70,229,0.15)' : 'none',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* CTA */}
        <button
          onClick={handleStart}
          disabled={starting}
          style={{
            width: '100%',
            padding: '14px 24px',
            borderRadius: '12px',
            background: starting
              ? 'linear-gradient(135deg, #4338CA 0%, #6D28D9 100%)'
              : 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
            color: '#FFFFFF',
            border: 'none',
            fontSize: '16px',
            fontWeight: 700,
            cursor: starting ? 'not-allowed' : 'pointer',
            transition: 'opacity 0.2s, transform 0.15s',
            fontFamily: 'Inter, sans-serif',
            letterSpacing: '0.2px',
            boxShadow: '0 4px 16px rgba(79,70,229,0.35)',
            transform: starting ? 'scale(0.98)' : 'scale(1)',
            marginBottom: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}
          onMouseEnter={(e) => {
            if (!starting) {
              e.currentTarget.style.boxShadow = '0 6px 24px rgba(79,70,229,0.5)'
              e.currentTarget.style.transform = 'translateY(-1px)'
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.boxShadow = '0 4px 16px rgba(79,70,229,0.35)'
            e.currentTarget.style.transform = 'scale(1)'
          }}
        >
          {starting ? (
            <>
              <span style={{ animation: 'spin 0.8s linear infinite', display: 'inline-block' }}>⟳</span>
              Starting…
            </>
          ) : (
            'Start Game'
          )}
        </button>

        {/* Custom question link */}
        <div style={{ textAlign: 'center' }}>
          <button
            onClick={() => navigate('/pricing')}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '13px',
              fontWeight: 500,
              color: '#64748B',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              fontFamily: 'Inter, sans-serif',
              padding: '4px 8px',
              borderRadius: '6px',
              transition: 'color 0.15s, background 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#4F46E5'
              e.currentTarget.style.background = '#F1F5F9'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#64748B'
              e.currentTarget.style.background = 'none'
            }}
          >
            <PlusCircle size={14} />
            Create custom question
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
          </button>
        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
