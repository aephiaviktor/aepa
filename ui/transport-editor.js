import { projectedReturnAvailability, rankTransportTargets } from '../dist/src/transport-model.js';

function renderCargoPicker(row,direction,available,selected,onChanged){
  const picker=row.querySelector(`[data-cargo-direction="${direction}"]`);
  const host=picker.querySelector('.transport-cargo-options');
  host.replaceChildren();
  for(const item of available){
    const saved=selected.find(value=>value.cargoId===item.cargoId);
    const label=document.createElement('label');
    const checkbox=document.createElement('input');
    checkbox.type='checkbox'; checkbox.dataset.cargoId=String(item.cargoId); checkbox.checked=!!saved;
    const name=document.createElement('span'); name.textContent=`${item.name} · available ${item.availableRaw}`;
    const amount=document.createElement('input');
    amount.type='number'; amount.min='1'; amount.step='1'; amount.value=saved?.amountRaw??''; amount.placeholder='Amount'; amount.disabled=!checkbox.checked; amount.max=item.availableRaw; amount.title=item.title??'';
    checkbox.addEventListener('change',()=>{amount.disabled=!checkbox.checked;if(!checkbox.checked)amount.value='';onChanged();});
    amount.addEventListener('input',onChanged);
    label.append(checkbox,name,amount); host.append(label);
  }
  picker.querySelector('summary').textContent=direction==='out'?'Cargo':'Cargo back';
}

export function refreshTransportEditor({row,draft,preferredDestination,catalog,replaceSelectOptions,onChanged}){
  const fleet=catalog.fleets.find(value=>value.address===draft.fleetAddress);
  const home=catalog.transportSystems?.find(value=>value.address===draft.homeSystemAddress);
  const targets=home&&fleet?rankTransportTargets({home,systems:catalog.transportSystems,fleet:fleet.travel,travelMode:draft.travelMode}):[];
  const targetSelect=row.querySelector('[data-field="destination"]');
  replaceSelectOptions(targetSelect,targets.map(value=>({value:value.address,label:`${value.name} · ${value.distance.toFixed(2)}`})),preferredDestination);
  const target=targets.find(value=>value.address===targetSelect.value);
  const outbound=row.initialCargoOut??draft.cargoOut??[];
  const outAvailable=(home?.cargo??[]).filter(item=>BigInt(item.amountRaw)>0n).map(item=>({...item,availableRaw:item.amountRaw}));
  const projected=projectedReturnAvailability(target?.cargo??[],outbound);
  const names=new Map([...(target?.cargo??[]),...(home?.cargo??[])].map(item=>[item.cargoId,item]));
  const backAvailable=projected.filter(item=>BigInt(item.projectedRaw)>0n).map(item=>({...(names.get(item.cargoId)??{cargoId:item.cargoId,name:`Cargo ${item.cargoId}`}),availableRaw:item.projectedRaw,title:`Live target ${item.liveRaw}; projected after outbound delivery ${item.projectedRaw}`}));
  renderCargoPicker(row,'out',outAvailable,outbound,onChanged);
  renderCargoPicker(row,'back',backAvailable,row.initialCargoBack??draft.cargoBack??[],onChanged);
  delete row.initialCargoOut; delete row.initialCargoBack;
  const crewOut=row.querySelector('[data-field="crew-out"]'),crewBack=row.querySelector('[data-field="crew-back"]');
  crewOut.max=String(Math.min(home?.availableCrew??0,fleet?.passengerCapacity??0)); crewOut.title=`Available at Home: ${home?.availableCrew??0}; passenger capacity: ${fleet?.passengerCapacity??0}`;
  crewBack.max=String(Math.min((target?.availableCrew??0)+(Number(crewOut.value)||0),fleet?.passengerCapacity??0)); crewBack.title=`Available at Target after delivery: ${(target?.availableCrew??0)+(Number(crewOut.value)||0)}; passenger capacity: ${fleet?.passengerCapacity??0}`;
}
