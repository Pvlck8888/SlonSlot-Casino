import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GameHeader } from "@/components/GameHeader";
import { BettingPanel } from "@/components/BettingPanel";
import { Button } from "@/components/ui/button";
import { useTelegram } from "@/components/TelegramProvider";
import { gamesConfig } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAudio } from "@/components/AudioProvider";
import { useLanguage } from "@/components/LanguageProvider";
import { Turtle, Footprints, Rabbit, Zap, Sparkles } from "lucide-react";

interface AviaMastersGameProps {
  balance: number;
  onBalanceChange: (newBalance: number) => void;
  onBack: () => void;
}

type GameStatus = "waiting" | "flying" | "landing" | "crashed" | "won";
type SpeedMode = 0 | 1 | 2 | 3;

interface Collectible {
  x: number;
  y: number;
  type: "add" | "multiply" | "rocket";
  value: number;
  collected: boolean;
}

interface Ship {
  // Position in world coordinates (0..N), the plane traverses to ~10 over a full flight.
  worldX: number;
  variant: number; // 0,1,2 for visual variety
}

interface FlightResult {
  success: boolean;
  collectibles: Collectible[];
  finalMultiplier: number;
  gameId: string;
  crashPoint?: number;
}

const SPEED_LABELS = ["0.5x", "1.0x", "1.5x", "2.5x"];
const SPEED_MULTIPLIERS = [0.5, 1, 1.5, 2.5];
const FLIGHT_DURATION_BASE_MS = 14000; // base full flight time at speed 1

export function AviaMastersGame({ balance, onBalanceChange, onBack }: AviaMastersGameProps) {
  const gameConfig = gamesConfig.find((g) => g.id === "aviamasters")!;
  const { hapticFeedback, user } = useTelegram();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { setCurrentGame, playSound } = useAudio();
  const { language } = useLanguage();

  const [gameStatus, setGameStatus] = useState<GameStatus>("waiting");
  const [speedMode, setSpeedMode] = useState<SpeedMode>(1);
  const [betAmount, setBetAmount] = useState(gamesConfig.find((g) => g.id === "aviamasters")?.minBet ?? 0.5);
  const [displayMultiplier, setDisplayMultiplier] = useState(1.0);
  const [displayHeight, setDisplayHeight] = useState(0);
  const [displayDistance, setDisplayDistance] = useState(0);
  const [autoBonus, setAutoBonus] = useState(false);
  const [collectibles, setCollectibles] = useState<Collectible[]>([]);
  const [flightResult, setFlightResult] = useState<FlightResult | null>(null);
  const collectiblesRef = useRef<Collectible[]>([]);
  const flightResultRef = useRef<FlightResult | null>(null);
  const displayMultiplierRef = useRef(1.0);
  const betAmountRef = useRef(0);
  const speedModeRef = useRef<SpeedMode>(1);
  const pickupsRef = useRef<{ id: number; text: string; color: string; x: number; y: number; t: number }[]>([]);
  const [history, setHistory] = useState<{ mult: number; won: boolean }[]>([
    { mult: 2.5, won: true }, { mult: 1.2, won: true }, { mult: 4.8, won: true },
    { mult: 0, won: false }, { mult: 3.2, won: true }, { mult: 1.8, won: true },
  ]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const startTimeRef = useRef<number>(0);
  const planeProgressRef = useRef(0); // 0..1
  const planeOscRef = useRef(0); // y oscillation phase
  const cloudOffsetRef = useRef(0);
  const waveOffsetRef = useRef(0);
  const worldOffsetRef = useRef(0); // for parallax of ships
  const shipsRef = useRef<Ship[]>([]);
  const pickupIdRef = useRef(0);
  const explosionRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const splashRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const trailRef = useRef<{ x: number; y: number; life: number }[]>([]);
  const endedRef = useRef(false); // idempotency guard for endMutation
  const prevProgressRef = useRef(0); // for crossing-based collectible detection
  const landingStartedAtRef = useRef<number | null>(null); // when "landing" began (rAF-driven, not useEffect)
  const lastDistanceUpdateRef = useRef(0);

  // Stable refs for callbacks/mutations so the rAF effect can depend ONLY on [gameStatus].
  // Without this, every parent re-render (e.g. setDisplayDistance) would recreate
  // endMutation/playSound and re-run the landing useEffect — its setTimeout would
  // be cleared every frame and the landing animation would never resolve.

  useEffect(() => {
    setCurrentGame("aviamasters");
  }, [setCurrentGame]);

  // Sync state to refs for animation loop
  useEffect(() => { collectiblesRef.current = collectibles; }, [collectibles]);
  useEffect(() => { flightResultRef.current = flightResult; }, [flightResult]);
  useEffect(() => { displayMultiplierRef.current = displayMultiplier; }, [displayMultiplier]);
  useEffect(() => { betAmountRef.current = betAmount; }, [betAmount]);
  useEffect(() => { speedModeRef.current = speedMode; }, [speedMode]);

  // Stable callback refs are assigned BELOW endMutation declaration.
  const endMutationRef = useRef<any>(null);
  const playSoundRef = useRef(playSound);
  playSoundRef.current = playSound;
  const hapticRef = useRef(hapticFeedback);
  hapticRef.current = hapticFeedback;

  // Generate ships once
  useEffect(() => {
    const ships: Ship[] = [];
    // ships at world positions 0.5, 2, 3.5, 5, 6.5, 8, 9.5, 11
    for (let i = 0; i < 8; i++) {
      ships.push({ worldX: 0.5 + i * 1.5, variant: i % 3 });
    }
    shipsRef.current = ships;
  }, []);

  const startMutation = useMutation({
    mutationFn: async (amount: number) => {
      const response = await apiRequest("POST", "/api/games/aviamasters/start", {
        odejs: user?.id || "demo",
        amount,
      });
      return response.json();
    },
    onSuccess: (data) => {
      const serverCollectibles: Collectible[] = (data.collectibles || []).map((c: any) => ({
        ...c,
        type: c.type as "add" | "multiply" | "rocket",
        collected: false,
      }));

      setFlightResult({
        success: data.success,
        collectibles: serverCollectibles,
        finalMultiplier: data.multiplier,
        gameId: data.gameId,
        crashPoint: data.crashPoint,
      });
      setCollectibles(serverCollectibles);

      if (data.newBalance !== undefined) onBalanceChange(data.newBalance);

      startTimeRef.current = Date.now();
      planeProgressRef.current = 0;
      prevProgressRef.current = 0;
      worldOffsetRef.current = 0;
      explosionRef.current = null;
      splashRef.current = null;
      trailRef.current = [];
      pickupsRef.current = [];
      endedRef.current = false;
      landingStartedAtRef.current = null;
      lastDistanceUpdateRef.current = 0;
      setGameStatus("flying");
      setDisplayMultiplier(1.0);
      setDisplayHeight(0);
      setDisplayDistance(0);
    },
    onError: () => {
      toast({
        title: language === "ru" ? "Ошибка" : "Error",
        description: language === "ru" ? "Не удалось начать игру" : "Failed to start game",
        variant: "destructive",
      });
      setGameStatus("waiting");
      queryClient.invalidateQueries({ queryKey: ["auth-user"] });
    },
  });

  const endMutation = useMutation({
    mutationFn: async (gameId: string) => {
      const response = await apiRequest("POST", "/api/games/aviamasters/end", {
        odejs: user?.id || "demo",
        gameId,
      });
      return response.json();
    },
    onSuccess: (data) => {
      if (data.newBalance !== undefined) onBalanceChange(data.newBalance);
      queryClient.invalidateQueries({ queryKey: ["auth-user"] });
    },
  });
  endMutationRef.current = endMutation;

  // Safety net: if the user navigates away or the component unmounts mid-flight,
  // settle the game so the bet isn't stranded on the server.
  useEffect(() => {
    return () => {
      const fr = flightResultRef.current;
      if (!endedRef.current && fr) {
        endedRef.current = true;
        try { endMutationRef.current?.mutate(fr.gameId); } catch {}
      }
    };
  }, []);

  const handlePlay = (amount: number) => {
    if (gameStatus !== "waiting") return;
    if (amount <= 0 || amount > balance) {
      toast({
        title: language === "ru" ? "Неверная ставка" : "Invalid bet",
        description: language === "ru" ? "Проверьте сумму ставки и баланс" : "Check your bet and balance",
        variant: "destructive",
      });
      return;
    }
    setBetAmount(amount);
    hapticFeedback("medium");
    startMutation.mutate(amount);
  };

  // Add a floating pickup label near plane (ref-only; rendered inside rAF)
  const spawnPickupLabel = useCallback((text: string, color: string, x: number, y: number) => {
    const id = ++pickupIdRef.current;
    pickupsRef.current = [...pickupsRef.current.slice(-6), { id, text, color, x, y, t: Date.now() }];
  }, []);

  // ========================= DRAW HELPERS =========================

  const drawSky = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const grad = ctx.createLinearGradient(0, 0, 0, h * 0.75);
    grad.addColorStop(0, "#0b1530");
    grad.addColorStop(0.5, "#13284f");
    grad.addColorStop(1, "#1d3a6b");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h * 0.75);

    // Stars
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    for (let i = 0; i < 30; i++) {
      const sx = (i * 73) % w;
      const sy = (i * 41) % (h * 0.4);
      ctx.fillRect(sx, sy, 1.2, 1.2);
    }
  };

  const drawClouds = (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => {
    cloudOffsetRef.current = (cloudOffsetRef.current + 0.15) % w;
    ctx.fillStyle = "rgba(120, 140, 200, 0.18)";
    for (let i = 0; i < 5; i++) {
      const cx = ((i * 200 - cloudOffsetRef.current) % (w + 200)) - 80;
      const cy = h * 0.18 + (i % 2) * 30;
      ctx.beginPath();
      ctx.arc(cx, cy, 22, 0, Math.PI * 2);
      ctx.arc(cx + 22, cy + 4, 18, 0, Math.PI * 2);
      ctx.arc(cx - 22, cy + 4, 18, 0, Math.PI * 2);
      ctx.arc(cx + 8, cy - 12, 14, 0, Math.PI * 2);
      ctx.fill();
    }

    // Faint AVIAMASTERS logo watermark
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = "#cfe6ff";
    ctx.font = "bold 28px Arial";
    ctx.textAlign = "center";
    ctx.fillText("AVIAMASTERS", w / 2, h * 0.12);
    ctx.font = "bold 16px Arial";
    ctx.fillText("2", w / 2, h * 0.16);
    ctx.restore();
  };

  const drawIsland = (ctx: CanvasRenderingContext2D, w: number, h: number, parallax: number) => {
    // Distant island silhouette behind ships
    const baseY = h * 0.66;
    const offset = (parallax * 0.3) % w;
    ctx.fillStyle = "#0d2238";
    for (let i = -1; i < 3; i++) {
      const cx = i * w * 0.7 - offset + w * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx - 90, baseY);
      ctx.quadraticCurveTo(cx - 60, baseY - 40, cx - 20, baseY - 28);
      ctx.quadraticCurveTo(cx + 20, baseY - 50, cx + 60, baseY - 25);
      ctx.quadraticCurveTo(cx + 90, baseY - 10, cx + 110, baseY);
      ctx.closePath();
      ctx.fill();
      // Palm trees on island
      ctx.strokeStyle = "#0a1a2c";
      ctx.fillStyle = "#0a1a2c";
      ctx.lineWidth = 2;
      const palms = [-30, 0, 30];
      for (const px of palms) {
        const tx = cx + px;
        const ty = baseY - 24;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.quadraticCurveTo(tx + 4, ty - 10, tx + 2, ty - 22);
        ctx.stroke();
        for (let f = 0; f < 5; f++) {
          const ang = -Math.PI / 2 + (f - 2) * 0.5;
          ctx.beginPath();
          ctx.moveTo(tx + 2, ty - 22);
          ctx.lineTo(tx + 2 + Math.cos(ang) * 10, ty - 22 + Math.sin(ang) * 10);
          ctx.stroke();
        }
      }
    }
  };

  const drawWater = (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => {
    const waterTop = h * 0.7;
    const grad = ctx.createLinearGradient(0, waterTop, 0, h);
    grad.addColorStop(0, "#0e2a48");
    grad.addColorStop(0.5, "#0a1f37");
    grad.addColorStop(1, "#06152a");
    ctx.fillStyle = grad;
    ctx.fillRect(0, waterTop, w, h - waterTop);

    // Wave lines
    waveOffsetRef.current = (waveOffsetRef.current + 0.4) % 60;
    ctx.strokeStyle = "rgba(120, 180, 255, 0.18)";
    ctx.lineWidth = 1;
    for (let row = 0; row < 5; row++) {
      const y = waterTop + 8 + row * 18;
      ctx.beginPath();
      for (let x = -10; x < w + 10; x += 8) {
        const yy = y + Math.sin((x + waveOffsetRef.current + row * 20) / 18) * 1.6;
        if (x === -10) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }

    // Water reflection of stars
    ctx.fillStyle = "rgba(180, 210, 255, 0.10)";
    for (let i = 0; i < 8; i++) {
      const rx = (i * 47 + (t / 60) % 30) % w;
      const ry = waterTop + 6 + (i % 3) * 20;
      ctx.fillRect(rx, ry, 6, 1);
    }
  };

  const drawShip = (ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, variant: number) => {
    // y is the deck top
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);

    // Hull (gradient)
    const hullGrad = ctx.createLinearGradient(0, 0, 0, 24);
    hullGrad.addColorStop(0, "#3a4a5e");
    hullGrad.addColorStop(1, "#1d2838");
    ctx.fillStyle = hullGrad;
    ctx.beginPath();
    ctx.moveTo(-50, 0);
    ctx.lineTo(-65, 18);
    ctx.lineTo(60, 18);
    ctx.lineTo(50, 0);
    ctx.closePath();
    ctx.fill();

    // Deck line
    ctx.fillStyle = "#5a6a7e";
    ctx.fillRect(-50, -3, 100, 4);

    // Landing strip (yellow markings on top)
    ctx.fillStyle = "#1c1810";
    ctx.fillRect(-46, -8, 92, 5);
    ctx.fillStyle = "#f4c531";
    for (let i = 0; i < 5; i++) {
      ctx.fillRect(-42 + i * 18, -6.5, 9, 2);
    }

    // Tower / cabin (variant)
    ctx.fillStyle = "#465468";
    if (variant === 0) {
      ctx.fillRect(28, -22, 16, 16);
      ctx.fillStyle = "#9bb4d4";
      ctx.fillRect(31, -19, 10, 5);
    } else if (variant === 1) {
      ctx.fillRect(-44, -20, 14, 14);
      ctx.fillStyle = "#9bb4d4";
      ctx.fillRect(-41, -17, 8, 4);
    } else {
      // Ramp-only ship (cleaner landing)
      ctx.fillStyle = "#465468";
      ctx.fillRect(36, -18, 8, 12);
    }

    // Reflection
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    ctx.ellipse(0, 22, 50, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  };

  // Render a faux-3D biplane with layered shading, perspective wings,
  // glossy cockpit dome, propeller motion-blur disc, and an underbelly shadow.
  const drawBiplane = (ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, scale: number = 1) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(scale, scale);

    // ---- Underbelly shadow on the ground/water (gives depth) ----
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(0, 28, 22, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ---- Lower wing (rear; darker, perspective-foreshortened) ----
    const lowerWingGrad = ctx.createLinearGradient(0, 6, 0, 14);
    lowerWingGrad.addColorStop(0, "#7d1212");
    lowerWingGrad.addColorStop(1, "#4a0a0a");
    ctx.fillStyle = lowerWingGrad;
    ctx.beginPath();
    ctx.moveTo(-22, 7);
    ctx.lineTo(22, 7);
    ctx.lineTo(20, 13);
    ctx.lineTo(-20, 13);
    ctx.closePath();
    ctx.fill();
    // wing leading-edge highlight
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(-22, 6.5, 44, 1.2);

    // ---- Fuselage (cylindrical body) ----
    // Outer silhouette
    ctx.beginPath();
    ctx.moveTo(-28, -2);
    ctx.quadraticCurveTo(-30, 4, -22, 8);
    ctx.lineTo(20, 8);
    ctx.quadraticCurveTo(28, 4, 24, -2);
    ctx.quadraticCurveTo(20, -8, 12, -8);
    ctx.lineTo(-12, -8);
    ctx.quadraticCurveTo(-26, -8, -28, -2);
    ctx.closePath();
    const bodyGrad = ctx.createLinearGradient(0, -8, 0, 10);
    bodyGrad.addColorStop(0, "#ff6a6a");
    bodyGrad.addColorStop(0.45, "#e63b3b");
    bodyGrad.addColorStop(1, "#7c1010");
    ctx.fillStyle = bodyGrad;
    ctx.fill();
    // Highlight stripe on top of fuselage
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.beginPath();
    ctx.moveTo(-22, -5);
    ctx.lineTo(18, -5);
    ctx.lineTo(16, -3.5);
    ctx.lineTo(-20, -3.5);
    ctx.closePath();
    ctx.fill();
    // Belly shadow line
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(-22, 5, 44, 2);

    // ---- Tail fin (vertical stab, with depth shading) ----
    ctx.fillStyle = "#8a1414";
    ctx.beginPath();
    ctx.moveTo(-22, -3);
    ctx.lineTo(-30, -14);
    ctx.lineTo(-22, -14);
    ctx.lineTo(-16, -3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.beginPath();
    ctx.moveTo(-22, -3);
    ctx.lineTo(-26, -10);
    ctx.lineTo(-22, -10);
    ctx.closePath();
    ctx.fill();
    // Horizontal stabilizer
    ctx.fillStyle = "#a01818";
    ctx.beginPath();
    ctx.moveTo(-26, -2);
    ctx.lineTo(-18, -2);
    ctx.lineTo(-20, 1);
    ctx.lineTo(-28, 1);
    ctx.closePath();
    ctx.fill();

    // ---- Upper wing (front; bigger, with depth) ----
    // Bottom shadow
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.moveTo(-22, -10);
    ctx.lineTo(22, -10);
    ctx.lineTo(20, -7);
    ctx.lineTo(-20, -7);
    ctx.closePath();
    ctx.fill();
    // Top surface
    const upperWingGrad = ctx.createLinearGradient(0, -16, 0, -10);
    upperWingGrad.addColorStop(0, "#ff5252");
    upperWingGrad.addColorStop(1, "#b21d1d");
    ctx.fillStyle = upperWingGrad;
    ctx.beginPath();
    ctx.moveTo(-24, -16);
    ctx.lineTo(24, -16);
    ctx.lineTo(22, -10);
    ctx.lineTo(-22, -10);
    ctx.closePath();
    ctx.fill();
    // wing leading-edge highlight
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(-24, -16, 48, 1.4);

    // ---- Wing struts (between wings, with depth) ----
    ctx.strokeStyle = "rgba(50,5,5,0.85)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-13, -10); ctx.lineTo(-13, 7);
    ctx.moveTo(13, -10); ctx.lineTo(13, 7);
    ctx.moveTo(-6, -10); ctx.lineTo(-6, 7);
    ctx.moveTo(6, -10); ctx.lineTo(6, 7);
    ctx.stroke();
    // Diagonal cross-brace cable (3D feel)
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(-12, -9); ctx.lineTo(12, 7);
    ctx.moveTo(12, -9); ctx.lineTo(-12, 7);
    ctx.stroke();

    // ---- Cockpit canopy (glossy dome) ----
    const cockpitGrad = ctx.createLinearGradient(0, -10, 0, -2);
    cockpitGrad.addColorStop(0, "#cfeaff");
    cockpitGrad.addColorStop(0.5, "#5aa6e6");
    cockpitGrad.addColorStop(1, "#1f4775");
    ctx.fillStyle = cockpitGrad;
    ctx.beginPath();
    ctx.ellipse(2, -5, 7, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0d2238";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    // Specular highlight
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.ellipse(0, -7, 2.4, 1.1, -0.3, 0, Math.PI * 2);
    ctx.fill();

    // ---- Engine cowling / nose (cone with shading) ----
    const noseGrad = ctx.createRadialGradient(22, -1, 1, 22, 0, 8);
    noseGrad.addColorStop(0, "#fff1a8");
    noseGrad.addColorStop(0.6, "#f0b727");
    noseGrad.addColorStop(1, "#8a5a0c");
    ctx.fillStyle = noseGrad;
    ctx.beginPath();
    ctx.arc(22, 0, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // ---- Propeller (motion-blur disc + faint blade silhouette) ----
    ctx.save();
    ctx.translate(28, 0);
    // disc
    const propDisc = ctx.createRadialGradient(0, 0, 1, 0, 0, 14);
    propDisc.addColorStop(0, "rgba(180,180,180,0.55)");
    propDisc.addColorStop(0.7, "rgba(120,120,120,0.18)");
    propDisc.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = propDisc;
    ctx.beginPath();
    ctx.ellipse(0, 0, 4, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    // animated faint blade
    const pa = (Date.now() / 8) % (Math.PI * 2);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = "#222";
    ctx.rotate(pa);
    ctx.fillRect(-1, -13, 2, 26);
    ctx.globalAlpha = 1;
    // hub
    ctx.rotate(-pa);
    ctx.fillStyle = "#1c1c1c";
    ctx.beginPath();
    ctx.arc(0, 0, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ---- Landing wheels (with strut depth) ----
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-6, 8); ctx.lineTo(-6, 13);
    ctx.moveTo(8, 8); ctx.lineTo(8, 13);
    ctx.stroke();
    ctx.fillStyle = "#161616";
    ctx.beginPath();
    ctx.arc(-6, 14, 3, 0, Math.PI * 2);
    ctx.arc(8, 14, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.beginPath();
    ctx.arc(-7, 13, 0.9, 0, Math.PI * 2);
    ctx.arc(7, 13, 0.9, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  };

  const drawMultiplierOrb = (ctx: CanvasRenderingContext2D, x: number, y: number, value: number, pulse: number) => {
    const r = 14 + Math.sin(pulse) * 1.5;
    ctx.save();
    ctx.shadowColor = "#5fb7ff";
    ctx.shadowBlur = 12;
    const g = ctx.createRadialGradient(x - 3, y - 3, 2, x, y, r);
    g.addColorStop(0, "#dbeeff");
    g.addColorStop(0.5, "#7fc2ff");
    g.addColorStop(1, "#2a73c2");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Inner stroke
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r - 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`×${value}`, x, y);
    ctx.restore();
  };

  const drawAddOrb = (ctx: CanvasRenderingContext2D, x: number, y: number, value: number, pulse: number) => {
    const r = 12 + Math.sin(pulse) * 1;
    ctx.save();
    ctx.shadowColor = "#7cf0c8";
    ctx.shadowBlur = 10;
    ctx.fillStyle = "#fff";
    ctx.font = "bold 16px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(value.toString(), x, y);
    ctx.shadowBlur = 0;
    ctx.restore();
  };

  // Faux-3D missile: cylindrical body with vertical lighting gradient,
  // shaded conical nose, two visible fins (front + back), and a layered exhaust flame.
  const drawMissile = (ctx: CanvasRenderingContext2D, x: number, y: number, fromLeft: boolean) => {
    ctx.save();
    ctx.translate(x, y);
    if (!fromLeft) ctx.scale(-1, 1);

    // ---- Smoke trail (puffs with growing radius and fading alpha) ----
    const tNow = Date.now() / 100;
    for (let i = 0; i < 6; i++) {
      const sx = -16 - i * 7 - Math.sin(tNow + i) * 1.2;
      const sy = Math.sin(tNow * 0.7 + i * 0.6) * 1.5;
      const r = 3 + i * 0.6;
      const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      grad.addColorStop(0, `rgba(220,220,220,${0.55 - i * 0.07})`);
      grad.addColorStop(1, "rgba(160,160,160,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- Drop shadow under the missile (depth cue) ----
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(0, 7, 14, 1.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ---- Rear fins (two stacked, depth shading) ----
    // Back fin (further away) — darker
    ctx.fillStyle = "#561010";
    ctx.beginPath();
    ctx.moveTo(-12, 0);
    ctx.lineTo(-17, -7);
    ctx.lineTo(-9, -2);
    ctx.closePath();
    ctx.fill();
    // Front fin (closer) — brighter
    ctx.fillStyle = "#a31a1a";
    ctx.beginPath();
    ctx.moveTo(-12, 0);
    ctx.lineTo(-17, 7);
    ctx.lineTo(-9, 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.beginPath();
    ctx.moveTo(-12, 0);
    ctx.lineTo(-15, 4);
    ctx.lineTo(-11, 1);
    ctx.closePath();
    ctx.fill();

    // ---- Cylindrical body with vertical 3D shading ----
    const bodyGrad = ctx.createLinearGradient(0, -3.5, 0, 3.5);
    bodyGrad.addColorStop(0, "#7a0e0e");
    bodyGrad.addColorStop(0.35, "#ff5252");
    bodyGrad.addColorStop(0.55, "#ffb3b3");
    bodyGrad.addColorStop(0.75, "#e63b3b");
    bodyGrad.addColorStop(1, "#5a0a0a");
    ctx.fillStyle = bodyGrad;
    // Rounded rectangle body
    const bx = -12, bw = 22, bh = 7;
    ctx.beginPath();
    ctx.moveTo(bx + 2, -bh / 2);
    ctx.lineTo(bx + bw, -bh / 2);
    ctx.lineTo(bx + bw, bh / 2);
    ctx.lineTo(bx + 2, bh / 2);
    ctx.quadraticCurveTo(bx, bh / 2, bx, 0);
    ctx.quadraticCurveTo(bx, -bh / 2, bx + 2, -bh / 2);
    ctx.closePath();
    ctx.fill();
    // Stencil ring (decorative)
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(-2, -3.2, 1.5, 6.4);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(-4.5, -3.2, 1, 6.4);

    // ---- Conical nose with radial shading ----
    const noseGrad = ctx.createLinearGradient(10, -3, 18, 3);
    noseGrad.addColorStop(0, "#ffd0d0");
    noseGrad.addColorStop(0.5, "#ff5252");
    noseGrad.addColorStop(1, "#7a0a0a");
    ctx.fillStyle = noseGrad;
    ctx.beginPath();
    ctx.moveTo(10, -3.5);
    ctx.quadraticCurveTo(20, -1.5, 22, 0);
    ctx.quadraticCurveTo(20, 1.5, 10, 3.5);
    ctx.closePath();
    ctx.fill();
    // Nose tip dark cap
    ctx.fillStyle = "#2a0303";
    ctx.beginPath();
    ctx.arc(21.5, 0, 1.4, 0, Math.PI * 2);
    ctx.fill();

    // ---- Exhaust flame (layered yellow-orange-red with flicker) ----
    const flick = Math.random() * 3;
    // outer red glow
    const redGrad = ctx.createRadialGradient(-12, 0, 1, -22 - flick, 0, 12);
    redGrad.addColorStop(0, "rgba(255,140,40,0.85)");
    redGrad.addColorStop(1, "rgba(255,40,0,0)");
    ctx.fillStyle = redGrad;
    ctx.beginPath();
    ctx.moveTo(-12, -3);
    ctx.quadraticCurveTo(-22 - flick, -2, -26 - flick, 0);
    ctx.quadraticCurveTo(-22 - flick, 2, -12, 3);
    ctx.closePath();
    ctx.fill();
    // mid orange
    ctx.fillStyle = "#ffaa33";
    ctx.beginPath();
    ctx.moveTo(-12, -2);
    ctx.lineTo(-19 - flick, 0);
    ctx.lineTo(-12, 2);
    ctx.closePath();
    ctx.fill();
    // hot core
    ctx.fillStyle = "#fff5b8";
    ctx.beginPath();
    ctx.moveTo(-12, -1);
    ctx.lineTo(-15 - flick * 0.5, 0);
    ctx.lineTo(-12, 1);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  };

  const drawExplosion = (ctx: CanvasRenderingContext2D, x: number, y: number, t: number) => {
    const radius = 8 + t * 80;
    const alpha = Math.max(0, 1 - t);
    ctx.save();
    ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, "#fff5d0");
    g.addColorStop(0.4, "#ff9020");
    g.addColorStop(1, "rgba(120,30,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    // Shards
    ctx.fillStyle = `rgba(255,200,80,${alpha})`;
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const dx = Math.cos(ang) * radius * 0.7;
      const dy = Math.sin(ang) * radius * 0.7;
      ctx.fillRect(x + dx - 2, y + dy - 2, 4, 4);
    }
    ctx.restore();
  };

  const drawSplash = (ctx: CanvasRenderingContext2D, x: number, y: number, t: number) => {
    const r = 6 + t * 40;
    const alpha = Math.max(0, 1 - t);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#7fc2ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(180,220,255,0.7)";
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2 - Math.PI / 2;
      const dx = Math.cos(ang) * r * 0.8;
      const dy = Math.sin(ang) * r * 0.6;
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  // ========================= MAIN ANIMATION LOOP =========================

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size to its CSS size with DPR
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    let lastTime = performance.now();

    const render = () => {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      ctx.clearRect(0, 0, w, h);
      drawSky(ctx, w, h);
      drawClouds(ctx, w, h, now);
      drawIsland(ctx, w, h, worldOffsetRef.current * 50);
      drawWater(ctx, w, h, now);

      // Compute plane progress
      const speedFactor = SPEED_MULTIPLIERS[speedModeRef.current];
      const flightR = flightResultRef.current;
      const baseY = h * 0.55;
      const planeOscAmp = 18;

      let planeX = w * 0.32;
      let planeY = baseY;
      let planeAngle = 0;

      if (gameStatus === "flying" || gameStatus === "landing") {
        const elapsed = (Date.now() - startTimeRef.current) / 1000;
        // Progress 0..1 for flight phase. Landing happens at p>=1.
        const totalDur = (FLIGHT_DURATION_BASE_MS / 1000) / speedFactor;
        const p = Math.min(1, elapsed / totalDur);
        planeProgressRef.current = p;
        worldOffsetRef.current = p * 8; // ships scroll under

        // Y oscillation - plane gently rises and falls. During landing, ease the
        // plane DOWN to the deck so the touchdown looks intentional.
        planeOscRef.current += dt * 1.2 * speedFactor;
        let oy = Math.sin(planeOscRef.current) * planeOscAmp - p * 6;
        if (gameStatus === "landing" && landingStartedAtRef.current != null) {
          const lp = Math.min(1, (Date.now() - landingStartedAtRef.current) / 800);
          oy = oy * (1 - lp) + 22 * lp; // settle onto the ship deck
          planeAngle = (Math.cos(planeOscRef.current) * 0.12) * (1 - lp);
        } else {
          planeAngle = Math.cos(planeOscRef.current) * 0.12;
        }
        planeY = baseY + oy - 25;

        // Throttled HUD updates (~10/s) — keeps state setters from triggering
        // 60 re-renders per second.
        if (now - lastDistanceUpdateRef.current > 100) {
          lastDistanceUpdateRef.current = now;
          setDisplayDistance(p * 500);
          setDisplayHeight(Math.max(0, 50 - oy * 0.4 + p * 25));
        }

        // Trail
        trailRef.current.push({ x: planeX - 16, y: planeY + 4, life: 1 });
        if (trailRef.current.length > 24) trailRef.current.shift();
        for (const t of trailRef.current) t.life -= dt * 1.6;
        trailRef.current = trailRef.current.filter((t) => t.life > 0);

        // Check if reached crashPoint and game is a loss → trigger explosion (idempotent)
        if (
          gameStatus === "flying" &&
          flightR &&
          !flightR.success &&
          flightR.crashPoint !== undefined &&
          p >= flightR.crashPoint &&
          !endedRef.current
        ) {
          endedRef.current = true;
          explosionRef.current = { x: planeX, y: planeY, t: 0 };
          splashRef.current = { x: planeX, y: baseY + 4, t: 0 };
          hapticRef.current?.("heavy");
          try { playSoundRef.current?.("crash"); } catch {}
          setGameStatus("crashed");
          endMutationRef.current.mutate(flightR.gameId);
        }

        // Successful landing animation when p reaches 1
        if (gameStatus === "flying" && flightR?.success && p >= 1 && !endedRef.current) {
          landingStartedAtRef.current = Date.now();
          hapticRef.current?.("medium");
          setGameStatus("landing");
        }

        // Resolve landing inline (rAF-driven; no useEffect race with state)
        if (
          gameStatus === "landing" &&
          flightR?.success &&
          !endedRef.current &&
          landingStartedAtRef.current != null &&
          Date.now() - landingStartedAtRef.current >= 800
        ) {
          endedRef.current = true;
          try { playSoundRef.current?.("win"); } catch {}
          hapticRef.current?.("heavy");
          setHistory((prev) => [{ mult: flightR.finalMultiplier, won: true }, ...prev.slice(0, 9)]);
          endMutationRef.current.mutate(flightR.gameId);
          setGameStatus("won");
        }

        // Process collected items as plane crosses them (prev<x && p>=x avoids frame-skip misses)
        if (flightR && gameStatus === "flying") {
          let collectedAny = false;
          const cur = collectiblesRef.current;
          const prevP = prevProgressRef.current;
          const next = cur.map((c) => {
            if (c.collected) return c;
            if (prevP < c.x && p >= c.x) {
              collectedAny = true;
              if (c.type === "add") {
                spawnPickupLabel(`+${c.value}`, "#7cf0c8", planeX + 28, planeY - 16);
                setDisplayMultiplier((m) => Math.min(250, m + c.value * 0.1));
                try { playSoundRef.current?.("luxeCoinDrop"); } catch {}
              } else if (c.type === "multiply") {
                spawnPickupLabel(`×${c.value}`, "#7fc2ff", planeX + 28, planeY - 20);
                setDisplayMultiplier((m) => Math.min(250, m * (1 + c.value * 0.1)));
                try { playSoundRef.current?.("luxeMultiplier"); } catch {}
              } else {
                // Rocket — halves the carried multiplier, but does NOT crash the plane.
                spawnPickupLabel("÷2", "#ff7373", planeX + 28, planeY - 16);
                setDisplayMultiplier((m) => Math.max(0.1, m * 0.5));
                hapticRef.current?.("medium");
                try { playSoundRef.current?.("crash"); } catch {}
              }
              return { ...c, collected: true };
            }
            return c;
          });
          if (collectedAny) {
            collectiblesRef.current = next;
            setCollectibles(next);
          }
        }

        prevProgressRef.current = p;
      } else if (gameStatus === "won") {
        // Final pose on a ship deck
        const lastShip = shipsRef.current[shipsRef.current.length - 1];
        const shipScreenX = w * 0.32 + (lastShip.worldX - worldOffsetRef.current) * 100;
        planeX = shipScreenX;
        planeY = baseY - 20;
        planeAngle = 0;
      }

      // Trail
      for (const t of trailRef.current) {
        ctx.fillStyle = `rgba(255,255,255,${0.25 * t.life})`;
        ctx.beginPath();
        ctx.arc(t.x, t.y, 3 * t.life, 0, Math.PI * 2);
        ctx.fill();
      }

      // Ships scrolling
      const shipScale = 0.95;
      for (const ship of shipsRef.current) {
        const sx = w * 0.32 + (ship.worldX - worldOffsetRef.current) * 110;
        if (sx < -100 || sx > w + 100) continue;
        drawShip(ctx, sx, baseY, shipScale, ship.variant);
      }

      // Multiplier orbs / collectibles & missiles around plane
      if ((gameStatus === "flying" || gameStatus === "landing") && flightR) {
        const pulse = now / 250;
        for (const c of collectiblesRef.current) {
          if (c.collected) continue;
          // Position: relative to current world progress
          const dx = (c.x - planeProgressRef.current) * w * 1.4;
          const cx = planeX + dx;
          const cy = (h * 0.18) + c.y * (h * 0.3);
          if (cx < -50 || cx > w + 50) continue;
          if (c.type === "rocket") {
            const fromLeft = cx < planeX;
            drawMissile(ctx, cx, cy, fromLeft);
          } else if (c.type === "multiply") {
            drawMultiplierOrb(ctx, cx, cy, c.value, pulse);
          } else {
            drawMultiplierOrb(ctx, cx, cy, c.value, pulse);
            drawAddOrb(ctx, cx, cy, c.value, pulse);
          }
        }
      }

      // Plane (not drawn during explosion)
      if (gameStatus !== "crashed" || (explosionRef.current && explosionRef.current.t < 0.4)) {
        drawBiplane(ctx, planeX, planeY, planeAngle, 1.1);
      }

      // Multiplier above plane during flight
      if (gameStatus === "flying" || gameStatus === "landing") {
        ctx.save();
        ctx.fillStyle = "#fff66b";
        ctx.shadowColor = "#000";
        ctx.shadowBlur = 4;
        ctx.font = "bold 13px Arial";
        ctx.textAlign = "center";
        ctx.fillText(`${(betAmountRef.current * displayMultiplierRef.current).toFixed(2)} USD`, planeX, planeY - 30);
        ctx.restore();
      }

      // Pickup labels (ref-driven; expire after 1.1s)
      pickupsRef.current = pickupsRef.current.filter((pp) => Date.now() - pp.t < 1100);
      for (const p of pickupsRef.current) {
        const age = (Date.now() - p.t) / 1100;
        ctx.save();
        ctx.globalAlpha = 1 - age;
        ctx.fillStyle = p.color;
        ctx.shadowColor = "#000";
        ctx.shadowBlur = 4;
        ctx.font = "bold 16px Arial";
        ctx.textAlign = "center";
        ctx.fillText(p.text, p.x, p.y - age * 24);
        ctx.restore();
      }

      // Explosion
      if (explosionRef.current) {
        explosionRef.current.t += dt * 1.4;
        if (explosionRef.current.t < 1) {
          drawExplosion(ctx, explosionRef.current.x, explosionRef.current.y, explosionRef.current.t);
        }
      }

      // Splash
      if (splashRef.current) {
        splashRef.current.t += dt * 1.2;
        if (splashRef.current.t < 1) {
          drawSplash(ctx, splashRef.current.x, splashRef.current.y, splashRef.current.t);
        }
      }

      animationRef.current = requestAnimationFrame(render);
    };

    render();
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [gameStatus]);
  // ^ deps intentionally only [gameStatus]; everything else read via stable refs.

  // After crash add to history
  useEffect(() => {
    if (gameStatus === "crashed" && flightResult) {
      setHistory((prev) => [{ mult: 0, won: false }, ...prev.slice(0, 9)]);
    }
  }, [gameStatus, flightResult]);

  // Reset button
  const handleReset = () => {
    setGameStatus("waiting");
    setFlightResult(null);
    setCollectibles([]);
    setDisplayMultiplier(1.0);
    setDisplayHeight(0);
    setDisplayDistance(0);
    explosionRef.current = null;
    splashRef.current = null;
    trailRef.current = [];
    pickupsRef.current = [];
    endedRef.current = false;
    prevProgressRef.current = 0;
    landingStartedAtRef.current = null;
    lastDistanceUpdateRef.current = 0;
  };

  // ========================= JSX =========================

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#040a18] to-[#0a1628] text-white">
      <GameHeader title={gameConfig.name} balance={balance} onBack={onBack} />

      <div className="max-w-md mx-auto px-3 pb-4 space-y-3">
        {/* Recent history */}
        <div className="flex gap-1 overflow-x-auto py-1">
          {history.map((h, i) => (
            <span
              key={i}
              className={`text-xs font-bold px-2 py-0.5 rounded-md whitespace-nowrap ${
                h.won ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
              }`}
              data-testid={`history-${i}`}
            >
              {h.won ? `×${h.mult.toFixed(2)}` : "💥"}
            </span>
          ))}
        </div>

        {/* Game canvas */}
        <div className="relative w-full rounded-2xl overflow-hidden border border-white/10 shadow-[0_8px_30px_rgba(0,0,0,0.6)]">
          <canvas
            ref={canvasRef}
            className="w-full block"
            style={{ height: "320px", touchAction: "none" }}
            data-testid="aviamasters-canvas"
          />

          {/* Top-left game tag */}
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/40 text-[10px] tracking-widest text-white/80 font-bold">
            AVIAMASTERS
          </div>

          {/* Crash / Win overlay */}
          {gameStatus === "crashed" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm">
              <div className="text-center">
                <div className="text-3xl font-black text-red-400 drop-shadow-lg">
                  {language === "ru" ? "КРУШЕНИЕ" : "CRASHED"}
                </div>
                <div className="text-xs text-red-200/80 mt-1">
                  {language === "ru" ? "Самолёт упал в море" : "Plane fell into the sea"}
                </div>
              </div>
            </div>
          )}
          {gameStatus === "won" && flightResult && (
            <div className="absolute inset-0 flex items-center justify-center bg-emerald-500/15 backdrop-blur-[2px]">
              <div className="text-center">
                <div className="text-3xl font-black text-emerald-300 drop-shadow-lg">
                  ×{flightResult.finalMultiplier.toFixed(2)}
                </div>
                <div className="text-sm text-emerald-200 font-semibold">
                  +${(betAmount * flightResult.finalMultiplier).toFixed(2)}
                </div>
                <div className="text-[11px] text-emerald-200/70 mt-1">
                  {language === "ru" ? "Посадка успешна" : "Landed successfully"}
                </div>
              </div>
            </div>
          )}
          {gameStatus === "landing" && (
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-amber-500/30 border border-amber-400/60 text-amber-100 text-xs font-bold">
              {language === "ru" ? "ПОСАДКА..." : "LANDING..."}
            </div>
          )}
        </div>

        {/* Speed picker + bonus */}
        <div className="flex items-center gap-2">
          <div className="flex bg-[#0e1a2e] rounded-full p-1 border border-white/10">
            {([
              { mode: 0 as SpeedMode, Icon: Turtle, label: SPEED_LABELS[0] },
              { mode: 1 as SpeedMode, Icon: Footprints, label: SPEED_LABELS[1] },
              { mode: 2 as SpeedMode, Icon: Rabbit, label: SPEED_LABELS[2] },
              { mode: 3 as SpeedMode, Icon: Zap, label: SPEED_LABELS[3] },
            ]).map(({ mode, Icon, label }) => (
              <button
                key={mode}
                onClick={() => gameStatus === "waiting" && setSpeedMode(mode)}
                disabled={gameStatus !== "waiting"}
                className={`relative px-2.5 py-1.5 rounded-full transition-all ${
                  speedMode === mode
                    ? "bg-white/15 text-white shadow-inner"
                    : "text-white/50 hover:text-white/80"
                } disabled:opacity-50`}
                data-testid={`button-speed-${mode}`}
                aria-label={label}
              >
                <Icon className="w-4 h-4" />
              </button>
            ))}
          </div>

          <button
            onClick={() => gameStatus === "waiting" && setAutoBonus((v) => !v)}
            disabled={gameStatus !== "waiting"}
            className={`flex-1 px-3 py-2 rounded-full border text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 transition-all ${
              autoBonus
                ? "bg-amber-500/30 border-amber-400/70 text-amber-100"
                : "bg-[#0e1a2e] border-white/10 text-white/60 hover:text-white/80"
            } disabled:opacity-50`}
            data-testid="button-bonus"
          >
            <Sparkles className="w-4 h-4" />
            {language === "ru" ? "АКТИВИРОВАТЬ БОНУС" : "ACTIVATE BONUS"}
          </button>
        </div>

        {/* HUD readouts */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-[#0e1a2e] border border-white/10 rounded-xl px-2 py-1.5 text-center">
            <div className="text-[10px] uppercase tracking-wider text-white/50">
              {language === "ru" ? "Высота" : "Height"}
            </div>
            <div className="font-bold text-base text-white" data-testid="text-height">
              {displayHeight.toFixed(1)}m
            </div>
          </div>
          <div className="bg-[#0e1a2e] border border-white/10 rounded-xl px-2 py-1.5 text-center">
            <div className="text-[10px] uppercase tracking-wider text-white/50">
              {language === "ru" ? "Расстояние" : "Distance"}
            </div>
            <div className="font-bold text-base text-white" data-testid="text-distance">
              {displayDistance.toFixed(1)}m
            </div>
          </div>
          <div className="bg-[#0e1a2e] border border-white/10 rounded-xl px-2 py-1.5 text-center">
            <div className="text-[10px] uppercase tracking-wider text-white/50">
              {language === "ru" ? "Множитель" : "Multiplier"}
            </div>
            <div className={`font-bold text-base ${displayMultiplier > 1.5 ? "text-emerald-300" : "text-white"}`} data-testid="text-multiplier">
              ×{displayMultiplier.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Bet & action */}
        {gameStatus === "waiting" ? (
          <BettingPanel
            balance={balance}
            minBet={gameConfig.minBet}
            maxBet={gameConfig.maxBet}
            onBet={handlePlay}
            isPlaying={startMutation.isPending}
            buttonText={language === "ru" ? "ВЗЛЁТ" : "TAKE OFF"}
            potentialMultiplier={2}
          />
        ) : (gameStatus === "won" || gameStatus === "crashed") ? (
          <Button
            className="w-full h-14 rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-extrabold text-lg tracking-wide"
            onClick={handleReset}
            data-testid="button-reset"
          >
            {language === "ru" ? "СНОВА" : "PLAY AGAIN"}
          </Button>
        ) : (
          <Button
            className="w-full h-14 rounded-2xl bg-amber-500/40 text-amber-100 font-extrabold text-lg tracking-wide cursor-not-allowed"
            disabled
            data-testid="button-flying"
          >
            {language === "ru" ? "В ПОЛЁТЕ..." : "IN FLIGHT..."}
          </Button>
        )}
      </div>
    </div>
  );
}
