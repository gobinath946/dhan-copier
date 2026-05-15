# Requirements Document

## Introduction

The Intelligent Nifty 50 Order Execution System is a specialized trading feature that enables users to execute BUY orders for Nifty 50 options across multiple trading accounts with intelligent lot allocation based on available capital and configured capital percentage. The system provides real-time position tracking, synchronized exit capabilities, and comprehensive profit/loss reporting at both account and trade levels.

## Glossary

- **System**: The Intelligent Nifty 50 Order Execution System
- **User**: The trader operating the system
- **Account**: A Dhan trading account with associated capital and configuration
- **Capital_Percentage**: The percentage of available capital that an account is configured to use for trading
- **Available_Capital**: The total funds available in a trading account
- **Usable_Capital**: The amount calculated as (Available_Capital × Capital_Percentage / 100)
- **Lot**: A standard trading unit for Nifty 50 options
- **Premium**: The price per unit of an option contract
- **Order_Value**: The total value of an order calculated as (Lots × Lot_Size × Premium)
- **Position**: An active trade that has been executed but not yet exited
- **Live_Price**: The current market price of a position updated in real-time
- **P&L**: Profit and Loss calculated as the difference between entry and exit values
- **Trade_Execution_Log**: A record of order entry and exit details
- **Account_P&L_Tracker**: A record of cumulative profit and loss per account
- **Trade_P&L_Record**: A record of profit or loss for a specific trade
- **Synchronized_Exit**: The simultaneous closing of positions across all accounts that participated in a trade

## Requirements

### Requirement 1: Instrument Restriction

**User Story:** As a user, I want the system to only allow Nifty 50 options trading, so that I can focus on a single instrument without risk of incorrect instrument selection.

#### Acceptance Criteria

1. THE System SHALL restrict all order execution to Nifty 50 options only
2. WHEN a user attempts to select an instrument, THE System SHALL display only Nifty 50 options
3. THE System SHALL prevent execution of orders for any instrument other than Nifty 50

### Requirement 2: Account Selection Interface

**User Story:** As a user, I want to select multiple accounts from a left sidebar, so that I can control which accounts participate in order execution.

#### Acceptance Criteria

1. THE System SHALL display all available accounts in a left sidebar
2. THE System SHALL display the Available_Capital for each account
3. THE System SHALL display the Capital_Percentage for each account
4. THE System SHALL allow the user to select individual accounts for order execution
5. THE System SHALL provide a "Select All" button that selects all available accounts
6. WHEN the user clicks "Select All", THE System SHALL select all accounts in the list
7. THE System SHALL visually indicate which accounts are currently selected

### Requirement 3: Capital-Based Lot Allocation

**User Story:** As a user, I want the system to automatically allocate lots to each account based on available capital and capital percentage, so that orders are distributed proportionally without manual calculation.

#### Acceptance Criteria

1. WHEN a user initiates an order execution, THE System SHALL calculate Usable_Capital for each selected account
2. THE System SHALL calculate the Premium for the selected Nifty 50 option automatically
3. THE System SHALL calculate Order_Value for the requested total lots
4. THE System SHALL allocate lots to each account proportionally based on Usable_Capital
5. WHEN an account's Usable_Capital is sufficient for at least one lot, THE System SHALL allocate a minimum of one lot to that account
6. WHEN an account's Usable_Capital is insufficient for even one lot, THE System SHALL allocate zero lots to that account
7. THE System SHALL ensure the sum of allocated lots across all accounts equals the user-requested total lots within a tolerance of plus or minus one lot
8. THE System SHALL display the calculated lot allocation per account before order execution

### Requirement 4: Buy-Only Order Execution

**User Story:** As a user, I want all orders to be BUY orders only, so that the system enforces a consistent entry-only execution pattern.

#### Acceptance Criteria

1. THE System SHALL execute only BUY transaction types
2. THE System SHALL prevent the user from selecting SELL as a transaction type
3. WHEN an order is placed, THE System SHALL set the transaction type to BUY

### Requirement 5: Multi-Account Order Execution

**User Story:** As a user, I want to execute orders across all selected accounts simultaneously, so that all accounts enter positions at approximately the same time.

#### Acceptance Criteria

1. WHEN the user confirms order execution, THE System SHALL place orders for all selected accounts concurrently
2. THE System SHALL use the allocated lot quantity for each account
3. THE System SHALL create a Trade_Execution_Log entry for the order execution
4. THE System SHALL create an account result record for each account's order
5. WHEN an order fails for an account, THE System SHALL record the failure reason and continue execution for other accounts
6. THE System SHALL display the execution status for each account after order placement

### Requirement 6: Live Price Tracking

**User Story:** As a user, I want to see live price updates for all active positions, so that I can monitor market movements in real-time.

#### Acceptance Criteria

1. WHEN positions are active, THE System SHALL display Live_Price for each position
2. THE System SHALL update Live_Price at intervals of 1 second or less
3. THE System SHALL display the current P&L for each active position based on Live_Price
4. THE System SHALL display P&L for each account with active positions
5. THE System SHALL calculate P&L as (Current_Value - Entry_Value) where Current_Value uses Live_Price
6. THE System SHALL display positive P&L in green and negative P&L in red

### Requirement 7: Synchronized Exit Execution

**User Story:** As a user, I want to exit all positions across all accounts with a single action, so that I can close trades quickly without manual per-account execution.

#### Acceptance Criteria

1. THE System SHALL provide a single exit button for closing all active positions
2. WHEN the user clicks the exit button, THE System SHALL place SELL orders for all accounts with active positions concurrently
3. THE System SHALL use the same lot quantity for exit as was used for entry for each account
4. THE System SHALL record the exit execution details in the Trade_Execution_Log
5. WHEN an exit order fails for an account, THE System SHALL record the failure and continue exit execution for other accounts
6. THE System SHALL display the exit status for each account after exit execution

### Requirement 8: Trade Execution Logging

**User Story:** As a user, I want detailed logs of all trade executions, so that I can review entry and exit details for audit and analysis purposes.

#### Acceptance Criteria

1. THE System SHALL create a Trade_Execution_Log entry for each order execution
2. THE Trade_Execution_Log SHALL include entry timestamp, symbol, total lots, and execution mode
3. THE Trade_Execution_Log SHALL include entry price and total entry value
4. WHEN a trade is exited, THE System SHALL update the Trade_Execution_Log with exit timestamp, exit price, and exit value
5. THE System SHALL display all Trade_Execution_Log entries in reverse chronological order
6. THE System SHALL allow the user to filter Trade_Execution_Log entries by date range

### Requirement 9: Per-Account P&L Tracking

**User Story:** As a user, I want to track profit and loss for each account separately, so that I can evaluate individual account performance.

#### Acceptance Criteria

1. THE System SHALL maintain an Account_P&L_Tracker for each account
2. WHEN a trade is exited, THE System SHALL calculate the P&L for each account's position
3. THE System SHALL update the Account_P&L_Tracker with the calculated P&L
4. THE System SHALL display cumulative P&L for each account
5. THE System SHALL allow the user to view monthly P&L reports for each account
6. THE System SHALL calculate monthly P&L as the sum of all trade P&L values within the month for that account

### Requirement 10: Per-Trade P&L Recording

**User Story:** As a user, I want to see profit or loss for each individual trade, so that I can identify which trades were profitable and which were not.

#### Acceptance Criteria

1. THE System SHALL create a Trade_P&L_Record for each completed trade
2. THE Trade_P&L_Record SHALL include entry value, exit value, and calculated P&L
3. THE Trade_P&L_Record SHALL include the timestamp of entry and exit
4. THE System SHALL display all Trade_P&L_Record entries in a dedicated table
5. THE System SHALL allow the user to sort Trade_P&L_Record entries by P&L amount
6. THE System SHALL calculate aggregate statistics including total profit, total loss, and win rate

### Requirement 11: Dashboard P&L Overview

**User Story:** As a user, I want to see an overall P&L dashboard, so that I can quickly assess total performance across all accounts.

#### Acceptance Criteria

1. THE System SHALL display an aggregate P&L dashboard showing total profit and loss across all accounts
2. THE System SHALL display total number of trades executed
3. THE System SHALL display win rate as the percentage of profitable trades
4. THE System SHALL display the best performing account by P&L
5. THE System SHALL display the worst performing account by P&L
6. THE System SHALL allow the user to drill down into individual account reports from the dashboard

### Requirement 12: Performance Optimization

**User Story:** As a user, I want the system to execute orders and update prices quickly, so that I can trade efficiently without delays.

#### Acceptance Criteria

1. WHEN the user initiates order execution, THE System SHALL complete the execution request within 2 seconds for up to 10 accounts
2. THE System SHALL update Live_Price data with a latency of 1 second or less from market data source
3. THE System SHALL render UI updates for price changes within 100 milliseconds of receiving new data
4. THE System SHALL use concurrent API calls for multi-account operations
5. THE System SHALL cache static data such as lot sizes and instrument details

### Requirement 13: Order Execution Page Redesign

**User Story:** As a user, I want an improved Order Execution page layout, so that I can execute trades more easily and efficiently.

#### Acceptance Criteria

1. THE System SHALL display the account selection sidebar on the left side of the Order Execution page
2. THE System SHALL display the order execution controls in a prominent central area
3. THE System SHALL display active positions and live prices below the execution controls
4. THE System SHALL display the exit button prominently when positions are active
5. THE System SHALL use clear visual hierarchy with larger fonts for critical information
6. THE System SHALL group related information using cards or panels
7. THE System SHALL provide responsive layout that adapts to different screen sizes

### Requirement 14: Data Persistence and Separation

**User Story:** As a user, I want all trade data stored in separate tables, so that data integrity is maintained and queries are efficient.

#### Acceptance Criteria

1. THE System SHALL store Trade_Execution_Log entries in a dedicated database table
2. THE System SHALL store Account_P&L_Tracker entries in a dedicated database table
3. THE System SHALL store Trade_P&L_Record entries in a dedicated database table
4. THE System SHALL store account result records in a dedicated database table
5. THE System SHALL use foreign key relationships to link related records across tables
6. THE System SHALL create database indexes on frequently queried fields including account ID, timestamp, and status

### Requirement 15: Premium Calculation Automation

**User Story:** As a user, I want the system to automatically calculate option premiums, so that I do not need to manually input prices.

#### Acceptance Criteria

1. WHEN a user selects a Nifty 50 option, THE System SHALL fetch the current market price automatically
2. THE System SHALL use the fetched price as the Premium for lot allocation calculations
3. WHEN the market price is unavailable, THE System SHALL display an error message and prevent order execution
4. THE System SHALL refresh the Premium every 5 seconds while the order execution interface is active
5. THE System SHALL display the Premium value to the user before order execution
