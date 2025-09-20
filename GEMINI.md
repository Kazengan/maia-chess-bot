# GEMINI.md: maia-chess

## Project Overview

This project is a chess bot that uses the Maia2 chess engine to suggest moves. It consists of a Python backend that runs the Maia2 model and a Tampermonkey user script to extract the game state from chess.com.

**Technologies:**
*   Python
*   PyTorch
*   Maia2
*   JavaScript (Tampermonkey)

**Files:**
*   `run_maia2.py`: The main Python script that loads the Maia2 model and calculates the best move for a given FEN string and ELO rating.
*   `requirements.txt`: Lists the Python dependencies for the project.
*   `tampermonkey-chess.js`: A user script for the Tampermonkey browser extension that extracts the FEN string from a live game on chess.com.

## Building and Running

### 1. Python Backend

To run the Python backend, you need to have Python and the dependencies installed.

**Installation:**

```bash
pip install -r requirements.txt
```

**Running:**

```bash
python run_maia2.py
```

The script will prompt you to enter an ELO rating and a FEN string.

### 2. Tampermonkey Script

To use the Tampermonkey script, you need to have the Tampermonkey browser extension installed.

1.  Install the Tampermonkey extension for your browser.
2.  Open the Tampermonkey dashboard and create a new script.
3.  Copy the content of `tampermonkey-chess.js` and paste it into the new script.
4.  Save the script.

The script will automatically run on chess.com game pages. It will log the FEN string to the browser's console and display a floating widget.

## Development Conventions

*   The Python script `run_maia2.py` contains comments and prompts in Indonesian.
*   The Tampermonkey script is well-structured and includes a UI for interacting with it.
