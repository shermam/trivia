import { BrowserRouter, Routes, Route } from 'react-router'
import { GameProvider } from './components/GameContext'
import { Header } from './components/Header'
import { GameSetup } from './components/GameSetup'
import { QuizPlay } from './components/QuizPlay'
import { GameOver } from './components/GameOver'
import { Pricing } from './components/Pricing'

export default function App() {
  return (
    <BrowserRouter>
      <GameProvider>
        <div style={{ minHeight: '100vh', background: '#F8FAFC', fontFamily: 'Inter, system-ui, sans-serif' }}>
          <Header />
          <Routes>
            <Route path="/" element={<GameSetup />} />
            <Route path="/play" element={<QuizPlay />} />
            <Route path="/game-over" element={<GameOver />} />
            <Route path="/pricing" element={<Pricing />} />
          </Routes>
        </div>
      </GameProvider>
    </BrowserRouter>
  )
}
