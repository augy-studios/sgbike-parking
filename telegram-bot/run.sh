#!/usr/bin/env bash
#
# Start the bot inside a tmux session, or attach to it if it is already up.
#
#   ./run.sh          start or attach
#   ./run.sh stop     stop the session
#   ./run.sh restart  stop then start
#   ./run.sh logs     tail the log file without attaching
#   ./run.sh status   is it running
#
# The bot runs in a tmux session so it keeps going after you disconnect from
# SSH. Detach with Ctrl+B then D, which leaves it running.

set -euo pipefail

SESSION="${TMUX_SESSION:-sgbike-bot}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$DIR/.venv"
LOG_DIR="$DIR/logs"
LOG_FILE="$LOG_DIR/bot.log"

mkdir -p "$LOG_DIR"

running() {
    tmux has-session -t "$SESSION" 2>/dev/null
}

start() {
    if running; then
        echo "Already running. Attaching to '$SESSION'."
        tmux attach -t "$SESSION"
        return
    fi

    if [[ ! -d "$VENV" ]]; then
        echo "No virtualenv at $VENV."
        echo "Run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
        exit 1
    fi

    if [[ ! -f "$DIR/.env" ]]; then
        echo "No .env file. Copy .env.example to .env and fill it in."
        exit 1
    fi

    echo "Starting '$SESSION'."
    # Unbuffered so the log file fills in as things happen rather than in
    # chunks when a buffer flushes.
    tmux new-session -d -s "$SESSION" -c "$DIR" \
        "'$VENV/bin/python' -u bot.py 2>&1 | tee -a '$LOG_FILE'"

    sleep 2
    if running; then
        echo "Running. Attach with: tmux attach -t $SESSION"
        echo "Logs: $LOG_FILE"
    else
        echo "It exited immediately. Last lines:"
        tail -n 30 "$LOG_FILE"
        exit 1
    fi
}

stop() {
    if running; then
        # SIGTERM first so the bot closes its clients and database cleanly.
        tmux send-keys -t "$SESSION" C-c 2>/dev/null || true
        sleep 2
        tmux kill-session -t "$SESSION" 2>/dev/null || true
        echo "Stopped."
    else
        echo "Not running."
    fi
}

case "${1:-start}" in
    start)   start ;;
    stop)    stop ;;
    restart) stop; sleep 1; start ;;
    logs)    tail -f "$LOG_FILE" ;;
    status)
        if running; then
            echo "Running in tmux session '$SESSION'."
        else
            echo "Not running."
            exit 1
        fi
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|logs|status}"
        exit 1
        ;;
esac
