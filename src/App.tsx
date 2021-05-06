import * as String from "fp-ts/String"
import * as Array from "fp-ts/Array"
import { useObservable, useObservableEagerState } from "observable-hooks"
import { memo } from "react"
import * as Rx from "rxjs"
import * as RxO from "rxjs/operators"
import unionize, { ofType, UnionOf } from "unionize"
import {
  initialCurrencyRates,
  formatCurrency,
  NumberInput,
  formatPrice,
  initialOrders,
  Table,
  uuidv4,
  OrdersType,
  getRandomOrder,
  getBaseCurrencyPrice,
} from "./utils"

const createCallback = <V,>() => {
  const subject = new Rx.Subject<V>()
  const event$ = subject.asObservable()
  const callback = (v: V) => subject.next(v)
  return [event$, callback] as const
}

const [rateChange$, onRateChange] = createCallback<{
  currency: string
  value: number
}>()

const currencyRates$ = Rx.connectable(
  rateChange$.pipe(
    RxO.scan(
      (acc, rateChange) => ({
        ...acc,
        [rateChange.currency]: rateChange.value,
      }),
      initialCurrencyRates,
    ),
    RxO.startWith(initialCurrencyRates),
  ),
  new Rx.ReplaySubject(1),
)
// TODO: memory leak?
currencyRates$.connect()

const currencies$ = currencyRates$.pipe(
  RxO.map(Object.keys),
  RxO.distinctUntilChanged(Array.getEq(String.Eq).equals),
)

const Action = unionize({
  Init: {},
  AddOrder: ofType<{}>(),
  UpdatePrice: ofType<{ id: string; value: number }>(),
  UpdateCurrency: ofType<{ id: string; value: string }>(),
})
// eslint-disable-next-line @typescript-eslint/no-redeclare
type Action = UnionOf<typeof Action>

const [priceChange$, onPriceChange] = createCallback<{
  id: string
  value: number
}>()
const [currencyChange$, onCurrencyChange] = createCallback<{
  id: string
  value: string
}>()

const [addOrder$, onAddOrder] = createCallback()

const action$ = Rx.merge(
  addOrder$.pipe(RxO.mapTo(Action.AddOrder())),
  priceChange$.pipe(RxO.map(Action.UpdatePrice)),
  currencyChange$.pipe(RxO.map(Action.UpdateCurrency)),
).pipe(RxO.startWith(Action.Init()))

const ordersReducer = (state: OrdersType, action: Action): OrdersType =>
  Action.match(action, {
    Init: () => state,
    AddOrder: () => {
      const newOrder = getRandomOrder(uuidv4())
      return { ...state, [newOrder.id]: newOrder }
    },
    UpdateCurrency: ({ id, value }) => ({
      ...state,
      [id]: { ...state[id], currency: value },
    }),
    UpdatePrice: ({ id, value }) => ({
      ...state,
      [id]: { ...state[id], price: value },
    }),
  })

const orders$ = Rx.connectable(
  action$.pipe(RxO.scan(ordersReducer, initialOrders)),
  new Rx.ReplaySubject(1),
)
// TODO: memory leak?
orders$.connect()

const orderIds$ = orders$.pipe(
  RxO.map(Object.keys),
  RxO.distinctUntilChanged(Array.getEq(String.Eq).equals),
)

const getOrderWithBaseCurrencyPrice = (id: string) => {
  const order$ = orders$.pipe(
    RxO.map((orders) => orders[id]),
    RxO.distinctUntilChanged(),
  )
  const currencyRate$ = Rx.combineLatest([order$, currencyRates$]).pipe(
    RxO.map(([order, currencyRates]) => currencyRates[order.currency]),
    RxO.distinctUntilChanged(),
  )
  return Rx.combineLatest([order$, currencyRate$]).pipe(
    RxO.map(([order, currencyRate]) => ({
      ...order,
      baseCurrencyPrice: getBaseCurrencyPrice(order.price, currencyRate),
    })),
  )
}
const getCurrencyRate = (currency: string) =>
  currencyRates$.pipe(
    RxO.map((currencyRates) => currencyRates[currency]),
    RxO.distinctUntilChanged(),
  )

const total$ = Rx.combineLatest([orders$, currencyRates$]).pipe(
  RxO.map(([orders, currencyRates]) =>
    Object.values(orders)
      .map((order) =>
        getBaseCurrencyPrice(order.price, currencyRates[order.currency]),
      )
      .reduce((a, b) => a + b, 0),
  ),
  RxO.distinctUntilChanged(),
)

const CurrencyRate: React.FC<{ currency: string }> = ({ currency }) => {
  const rate = useObservableEagerState(
    useObservable(() => getCurrencyRate(currency)),
  )
  return (
    <tr key={currency}>
      <td>{formatCurrency(currency)}</td>
      <td>
        <NumberInput
          value={rate}
          onChange={(value) => {
            onRateChange({ currency, value })
          }}
        />
      </td>
    </tr>
  )
}

const Currencies = () => {
  const currencies = useObservableEagerState(currencies$)
  return (
    <Table columns={["Currency", "Exchange rate"]}>
      {currencies.map((currency) => (
        <CurrencyRate key={currency} currency={currency} />
      ))}
    </Table>
  )
}

const CurrencySelector: React.FC<{
  value: string
  onChange: (next: string) => void
}> = ({ value, onChange }) => {
  const currencies = useObservableEagerState(currencies$)
  return (
    <select
      onChange={(e) => {
        onChange(e.target.value)
      }}
      value={value}
    >
      {currencies.map((c) => (
        <option key={c} value={c}>
          {formatCurrency(c)}
        </option>
      ))}
    </select>
  )
}

const Orderline: React.FC<{ id: string }> = memo(({ id }) => {
  const order = useObservableEagerState(
    useObservable(() => getOrderWithBaseCurrencyPrice(id)),
  )
  return (
    <tr>
      <td>{order.title}</td>
      <td>
        <NumberInput
          value={order.price}
          onChange={(value) => {
            onPriceChange({ id, value })
          }}
        />
      </td>
      <td>
        <CurrencySelector
          value={order.currency}
          onChange={(value) => {
            onCurrencyChange({ id, value })
          }}
        />
      </td>
      <td>{formatPrice(order.baseCurrencyPrice)}£</td>
    </tr>
  )
})

const Orders = () => {
  const orderIds = useObservableEagerState(orderIds$)
  return (
    <Table columns={["Article", "Price", "Currency", "Price in £"]}>
      {orderIds.map((id) => (
        <Orderline key={id} id={id} />
      ))}
    </Table>
  )
}

const OrderTotal = () => {
  const total = useObservableEagerState(total$)
  return <div className="total">{formatPrice(total)}£</div>
}

const App = () => (
  <div className="App">
    <h1>Orders</h1>
    <Orders />
    <div className="actions">
      <button onClick={onAddOrder}>Add</button>
      <OrderTotal />
    </div>
    <h1>Exchange rates</h1>
    <Currencies />
  </div>
)

export default App
