# Game — next phase

Implement the game screen using validated server state from the session store.
Do not draw numbers, determine wins, or award money on the client. Sequence gaps
must pause updates until a server snapshot restores state. Claims are commands,
not locally accepted outcomes.
